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
        // A many2one value arrives as `{ id, display_name }`, a bare id or `false`.
        const stage = rec.stage_id;
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
 * - `crmServerValues` is the server-value snapshot of the current root, a
 *   `Map<number, {stageId: number|false, revenue: number|undefined}>` holding, per
 *   lead id, the server stage and expected revenue as that root first received
 *   them: from the root load that built it, then from its later group loads
 *   (toggle, "load more"). It is an in-memory arithmetic snapshot, not a cache: it
 *   persists nothing and serves no read. `CrmMobilePipeline` reads the snapshot
 *   of the root it displays (its `_crmServerValues`, see below) to compute the
 *   header revenue delta of the leads moved or edited since the server computed
 *   that root's group aggregates: until a root load ends, the view may still
 *   display the previous root while the new one is installed.
 * - Each root owns its snapshot: the map is created with the root, and the root
 *   and every list it holds keep it as `_crmServerValues`. The snapshot is
 *   therefore the current one exactly when its root is installed as `root`, a
 *   superseded load (one whose root was replaced, even while it still awaits its
 *   progress bar) only ever fills its own root's map, and a failed load builds no
 *   root, so the previous root keeps its snapshot. Fresh server data set on the
 *   current root outside a root load (disk-cache update, root reload, leaving
 *   sample mode) gives that root a new map.
 * - `_crmLoadingServerValues` is the map that the lists being built synchronously
 *   right now bind to (`null` otherwise). `_crmBuildWith` sets it around the
 *   creation of a root and of each group, so that every list records into the map
 *   of the root it belongs to.
 * - `crmUseDesktopSpec` is an optional model hook (`params.hooks`), supplied by
 *   `CrmMobilePipelineController`: when a root load fails with a lost connection
 *   and the hook returns `true`, the load is retried once, and the controller's
 *   `onWillLoadRoot` hook applies the desktop load variant, which a wide-layout
 *   visit may have cached. Without the hook (`crm_kanban`, forecast), a failed
 *   load rethrows exactly as before.
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
     * propagates as the framework raises it. The server-value snapshot needs no
     * handling here: it belongs to the root the load builds.
     */
    async load(params = {}) {
        try {
            await super.load(...arguments);
        } catch (error) {
            if (!(error instanceof ConnectionLostError) || !this.hooks.crmUseDesktopSpec?.()) {
                throw error;
            }
            await super.load(...arguments);
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
     * outside a root load first gives the root a new snapshot.
     */
    _setData(data) {
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
