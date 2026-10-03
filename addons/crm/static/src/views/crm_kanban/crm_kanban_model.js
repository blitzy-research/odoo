import { toRaw } from "@odoo/owl";
import { checkRainbowmanMessage } from "@crm/views/check_rainbowman_message";
import { ConnectionLostError } from "@web/core/network/rpc";
import { RelationalModel } from "@web/model/relational_model/relational_model";

/**
 * Records, into the server-value snapshot of `list`, the server stage and expected
 * revenue of raw records just received from the server, for the ids it does not
 * hold yet. The first value kept for an id is therefore the one the group
 * aggregates were computed from: a record moved or edited locally is never
 * re-read, and a later non-root load returning post-save values for it cannot
 * overwrite that value.
 *
 * The target is the map the list was bound to when it was built: the snapshot of
 * its root (see `CrmKanbanModel`). A later group toggle or "load more" therefore
 * extends the snapshot of the root holding that group, never the one of another
 * root. Sample data is never recorded: while sample records are displayed
 * (`useSampleModel`) or loaded through the sample ORM, which happens before
 * `useSampleModel` is set.
 *
 * @param {CrmKanbanDynamicRecordList} list the list receiving the records
 * @param {Object[]} records raw server records (`data.records` of a list)
 */
function recordCrmServerValues(list, records) {
    const { model } = list;
    if (model.useSampleModel || model.orm?.isSample) {
        return;
    }
    const target = list._crmServerValues;
    if (!target || !Array.isArray(records)) {
        return;
    }
    for (const rec of records) {
        if (!rec?.id || target.has(rec.id)) {
            continue;
        }
        // A many2one value arrives as `{ id, display_name }`, `[id, display_name]`
        // (which the relational model's `parseServerValue` also accepts), a bare id
        // or `false`.
        const stage = Array.isArray(rec.stage_id) ? rec.stage_id[0] : rec.stage_id;
        target.set(rec.id, {
            stageId: typeof stage === "object" && stage ? stage.id : stage || false,
            revenue: rec.expected_revenue,
        });
    }
}

/**
 * Whether `datapoint` is the model's current root. Datapoints are reactive
 * proxies and the model may be read through one, so both sides are compared
 * raw.
 *
 * @param {Object} datapoint
 * @returns {boolean}
 */
function isCurrentRoot(datapoint) {
    return toRaw(datapoint.model.root) === toRaw(datapoint);
}

/**
 * Offline, the framework queues the `unlink` of deleted records and returns
 * without removing them from the list. This removes the given records that the
 * list still holds, so that their cards disappear at once and the counts drop.
 * Ids are datapoint ids, not `resId`s. A delete of a selection (no `records`)
 * has nothing to remove here. Online, the delete has reloaded the model, so
 * nothing is done.
 *
 * @param {Object} list `CrmKanbanDynamicRecordList` or `CrmKanbanDynamicGroupList`
 * @param {Object[]} records the records passed to `_deleteRecords`
 */
async function removeRecordsDeletedOffline(list, records) {
    if (!list.model.offlinePlugin.isOffline()) {
        return;
    }
    const ids = records.map((r) => r.id).filter((id) => list.records.some((r) => r.id === id));
    if (ids.length) {
        await list._removeRecords(ids);
    }
}

/**
 * CRM kanban model, also used by `crm_mobile_pipeline` and, through
 * `ForecastKanbanModel`, by the forecast kanban.
 *
 * Each root owns a transient snapshot of server stage and revenue for mobile
 * header deltas, held as `_crmServerValues` and exposed for the current root as
 * `crmServerValues`. Its lists retain that snapshot across group loads, so
 * overlapping loads cannot mix roots. The snapshot persists nothing and serves
 * no reads.
 */
export class CrmKanbanModel extends RelationalModel {
    setup(params, { effect }) {
        super.setup(...arguments);
        this.effect = effect;
        // Assigned here rather than as a class field: `Model`'s constructor runs
        // `setup` (including subclasses' such as ForecastKanbanModel) before any
        // class field of this class would be initialised.
        this._crmLoadingServerValues = null;
    }

    /**
     * Server-value snapshot of the current root (see the class description), or
     * `undefined` while no root exists.
     *
     * @returns {Map<number, {stageId: number|false, revenue: number|undefined}>|undefined}
     */
    get crmServerValues() {
        return this.root?._crmServerValues;
    }

    /**
     * @override
     *
     * Offline, a root load of the mobile variant that could not be served is
     * retried once when the `crmUseDesktopSpec` hook asks for it (the hook switches
     * to the desktop variant); the error of that retry, like any other error,
     * propagates as the framework raises it. Each variant is read as
     * `_crmLoadRoot` reads it, so a load makes at most four attempts. The
     * server-value snapshot needs no handling here: it belongs to the root the load
     * builds.
     */
    async load(params = {}) {
        try {
            await this._crmLoadRoot(...arguments);
        } catch (error) {
            if (!(error instanceof ConnectionLostError) || !this.hooks.crmUseDesktopSpec?.()) {
                throw error;
            }
            await this._crmLoadRoot(...arguments);
        }
    }

    /**
     * The framework's root load. Offline, a load that sent the opening info of the
     * groups and could not be served is retried once without it when the
     * `crmLoadWithoutOpeningInfo` hook asks for it. The RPC cache keys a root load
     * on its full request, and the model sends that info with every root load once
     * a group was loaded on its own (e.g. by "Load more"): the cache holds no such
     * request until one was answered online, but it holds the request of the last
     * root load made before, which sent none. The model's configuration gets the
     * info back once the retry ends, served or not, so the root loads that follow
     * send it again, as the framework sends it: online, they keep the groups as they
     * were loaded. Any other error, and that of the retry, propagates.
     *
     * @param {Object} [params]
     * @returns {Promise<void>}
     */
    async _crmLoadRoot(params = {}) {
        try {
            await super.load(...arguments);
        } catch (error) {
            if (
                !(error instanceof ConnectionLostError) ||
                !this.config.sendOpeningInfo ||
                !this.hooks.crmLoadWithoutOpeningInfo?.()
            ) {
                throw error;
            }
            delete this.config.sendOpeningInfo;
            try {
                await super.load(...arguments);
            } finally {
                this.config.sendOpeningInfo = true;
            }
        }
    }

    /**
     * @override
     *
     * Every root, including the empty one of the first load, is built with a
     * fresh server-value snapshot of its own.
     */
    _createRoot(config, data) {
        return this._crmBuildWith(new Map(), () => super._createRoot(...arguments));
    }

    /**
     * Runs `fn`, which builds datapoints synchronously, with `map` as the snapshot
     * the lists it creates bind to, then restores the previous binding (that of an
     * enclosing build, or `null`).
     *
     * @template T
     * @param {Map<number, Object>} map
     * @param {() => T} fn
     * @returns {T} the result of `fn`
     */
    _crmBuildWith(map, fn) {
        const previous = this._crmLoadingServerValues;
        this._crmLoadingServerValues = map;
        try {
            return fn();
        } finally {
            this._crmLoadingServerValues = previous;
        }
    }
}

export class CrmKanbanDynamicGroupList extends RelationalModel.DynamicGroupList {
    /**
     * @override
     *
     * Binds the list to the server-value snapshot of the root being built (see
     * `CrmKanbanModel`) before `super` sets its data.
     */
    setup(config, data) {
        this._crmServerValues = this.model._crmLoadingServerValues || new Map();
        super.setup(...arguments);
    }

    /**
     * @override
     *
     * If the kanban view is grouped by stage_id check if the lead is won and display
     * a rainbowman message if that's the case. The lookup is decorative, so it is
     * skipped while offline: the connection is read once the move has been saved
     * (or queued, which flips the offline signal), so nothing is issued, queued or
     * raised.
     */
    async moveRecord(dataRecordId, dataGroupId, refId, targetGroupId) {
        await super.moveRecord(...arguments);
        const sourceGroup = this.groups.find((g) => g.id === dataGroupId);
        const targetGroup = this.groups.find((g) => g.id === targetGroupId);
        if (
            dataGroupId !== targetGroupId &&
            sourceGroup &&
            targetGroup &&
            sourceGroup.groupByField.name === "stage_id" &&
            !this.model.offlinePlugin.isOffline()
        ) {
            const record = targetGroup.list.records.find((r) => r.id === dataRecordId);
            await checkRainbowmanMessage(this.model.orm, this.model.effect, record.resId);
        }
    }

    /**
     * @override
     *
     * Fresh server data set on the current grouped root outside a root load gives
     * the root a new server-value snapshot: the groups, and with them every
     * group's record list, are then built by `super` bound to that map. Any other
     * list keeps the snapshot it was built with.
     */
    _setData(data) {
        if (this.config.isRoot && isCurrentRoot(this)) {
            this._crmServerValues = new Map();
        }
        super._setData(...arguments);
    }

    /**
     * @override
     *
     * Builds the group, and with it the group's list, bound to this list's
     * server-value snapshot, so that the lists of a root all record into that
     * root's map.
     */
    _createGroupDatapoint(data) {
        return this.model._crmBuildWith(this._crmServerValues, () =>
            super._createGroupDatapoint(...arguments)
        );
    }

    /**
     * @override
     *
     * The kanban card menu deletes through the root (`model.root.deleteRecords`),
     * which is this list when grouped: offline, the deleted cards are removed from
     * their groups at once, each group decrementing its own count.
     */
    async _deleteRecords(records) {
        const res = await super._deleteRecords(...arguments);
        await removeRecordsDeletedOffline(this, records);
        return res;
    }
}

export class CrmKanbanDynamicRecordList extends RelationalModel.DynamicRecordList {
    /**
     * @override
     *
     * Binds the list to the server-value snapshot of the root being built (see
     * `CrmKanbanModel`) before `super` sets its data.
     */
    setup(config, data) {
        this._crmServerValues = this.model._crmLoadingServerValues || new Map();
        super.setup(...arguments);
    }

    /**
     * @override
     *
     * Records the server stage and revenue of the received records into the
     * list's snapshot (see `recordCrmServerValues`) before `super` builds the
     * record datapoints. Fresh server data set on the current ungrouped root
     * outside a root load first gives the root a new snapshot. During a
     * `crmLoadMissingRecords` load, first notes the root's opening-info flag,
     * which the model sets right after this commit.
     */
    _setData(data) {
        this._crmBeforeCommit?.();
        if (this.config.isRoot && isCurrentRoot(this)) {
            this._crmServerValues = new Map();
        }
        recordCrmServerValues(this, data.records);
        super._setData(...arguments);
    }

    /**
     * @override
     *
     * Non-root lists (kanban groups) are loaded without the RPC cache, so offline
     * their loads can only fail: the reload of a partially loaded source column
     * after a stage move, or the toggle of a never-loaded group. Offline, such a
     * load is skipped, and the list keeps the records it holds. Root loads, which
     * the cache serves offline, are untouched.
     */
    async _load(offset, limit, orderBy, domain) {
        if (!this.config.isRoot && this.model.offlinePlugin.isOffline()) {
            return;
        }
        return super._load(...arguments);
    }

    /**
     * Loads the records of this group list while it holds none, with the request
     * `Group.toggle` sends for a folded group, but without the toggle's effects
     * on other datapoints: the group's fold state is not changed, and the root
     * gets back the `sendOpeningInfo` flag it had. The model sets that flag on the
     * root after every non-root load (`_updateConfig`), so that the next root
     * request sends the opening info of every group; that request would then
     * differ from the one the RPC cache holds, and could not be served offline.
     * The flag is noted at this load's commit, right before the model sets it, on
     * the root the model sets it on, even when a root load replaced the root
     * meanwhile. The load runs in the model's mutex, as `load` does, so a "Load
     * more" keeps the flag it sets. Offline, `_load` issues no request. Calls made
     * while a load is pending share it. Used by the mobile pipeline only.
     *
     * @returns {Promise<void>}
     */
    crmLoadMissingRecords() {
        if (!this._crmMissingRecordsLoad) {
            this._crmMissingRecordsLoad = this.model.mutex
                .exec(async () => {
                    if (this.records.length) {
                        return;
                    }
                    let restoreRootFlag = null;
                    this._crmBeforeCommit = () => {
                        const rootConfig = this.model.root?.config;
                        if (!rootConfig) {
                            return;
                        }
                        const hadFlag = Object.hasOwn(rootConfig, "sendOpeningInfo");
                        const flag = rootConfig.sendOpeningInfo;
                        restoreRootFlag = () => {
                            if (hadFlag) {
                                rootConfig.sendOpeningInfo = flag;
                            } else {
                                delete rootConfig.sendOpeningInfo;
                            }
                        };
                    };
                    try {
                        // `_load`, not `load`: this already runs in the mutex.
                        await this._load(this.offset, this.limit, this.orderBy, this.domain);
                    } finally {
                        this._crmBeforeCommit = null;
                        restoreRootFlag?.();
                    }
                })
                .finally(() => {
                    this._crmMissingRecordsLoad = null;
                });
        }
        return this._crmMissingRecordsLoad;
    }

    /**
     * @override
     *
     * Offline, the deleted records are removed from the list at once (ungrouped
     * root, or a group's list through `Group.deleteRecords`, the group then
     * decrementing its own count). Online, `super` reloads the model.
     */
    async _deleteRecords(records) {
        const res = await super._deleteRecords(...arguments);
        await removeRecordsDeletedOffline(this, records);
        return res;
    }
}

CrmKanbanModel.DynamicGroupList = CrmKanbanDynamicGroupList;
CrmKanbanModel.DynamicRecordList = CrmKanbanDynamicRecordList;
CrmKanbanModel.services = [...RelationalModel.services, "effect"];
