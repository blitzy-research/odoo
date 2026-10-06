import { toRaw, untrack } from "@odoo/owl";
import {
    CRM_STAGE_CHOICES_KEY,
    crmLeadWriteTurn,
    crmPendingLeadWrites,
} from "@crm/mobile/crm_offline_hooks";
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
 * Turn of an online delete, from `list`, of leads the replay has still to send
 * queued writes of (`crmLeadWriteTurn`): an `unlink` sent ahead of them would make
 * them fail and park. The leads are the given records, else (a delete of the
 * selection) the selected ones.
 *
 * @param {Object} list `CrmKanbanDynamicRecordList` or `CrmKanbanDynamicGroupList`
 * @param {Object[]} records the records passed to `_deleteRecords`
 * @returns {Promise<void>|undefined} `undefined` when the delete may be sent now
 */
function deleteTurn(list, records) {
    const targets = records.length ? records : list.selection || [];
    return crmLeadWriteTurn(list.model.offlinePlugin, targets);
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
 *
 * A write of a lead from its card (a save, such as a stage move or a colour, or a
 * delete) made while the replay has still to send queued writes of that lead waits
 * for them, whatever connection state the plugin reports (`crmWriteInTurn`,
 * `crmLeadWriteTurn`), so that the write made last reaches the server last. A card
 * save made while the connection is reported lost and such a write is pending is
 * queued after it instead of being sent (`CrmKanbanRecord`).
 */
export class CrmKanbanModel extends RelationalModel {
    setup(params, { effect }) {
        super.setup(...arguments);
        this.effect = effect;
        // Assigned here rather than as class fields: `Model`'s constructor runs
        // `setup` (including subclasses' such as ForecastKanbanModel) before any
        // class field of this class would be initialised.
        this._crmLoadingServerValues = null;
        /** @type {Set<Promise<void>>} settlements of the writes `crmWriteInTurn` holds */
        this._crmHeldWrites = new Set();
        /**
         * Root configurations of loads given `crmStageChoices`, mapped to that
         * callback, until their first ungrouped request (`_loadUngroupedList`).
         *
         * @type {WeakMap<Object, (stages: {id: number, display_name: string}[]|null) => void>}
         */
        this._crmStageChoicesCallbacks = new WeakMap();
    }

    /**
     * Runs `write`, a write of the lead `record` setting `fieldNames`, once the
     * replay has sent (or parked) the queued writes of that lead it must follow, or
     * has ended (`crmLeadWriteTurn`), so that the server keeps the value written
     * last; a connection reported lost meanwhile does not end the wait. With no
     * replay running, or none of those writes left, `write` runs at once, with no
     * added wait. A held write marks the record (`crmTurnWrite`, which the mobile
     * projections read): its values of `fieldNames` show over the queued and
     * replayed writes stamped up to now, while it waits and once it is done, until
     * a reload replaces the record; a write that fails or saves nothing (`false`)
     * drops the mark. Root loads started meanwhile wait for the held write (`load`),
     * so that the reload ending a replay reads what it wrote.
     *
     * @template T
     * @param {Object} record
     * @param {string[]} fieldNames
     * @param {() => Promise<T>} write
     * @returns {Promise<T>}
     */
    crmWriteInTurn(record, fieldNames, write) {
        const turn = crmLeadWriteTurn(this.offlinePlugin, [record], fieldNames);
        if (!turn) {
            return write();
        }
        const mark = { timeStamp: Date.now(), fieldNames: [...fieldNames] };
        record.crmTurnWrite = mark;
        const dropMark = () => {
            if (toRaw(record.crmTurnWrite) === mark) {
                record.crmTurnWrite = undefined;
            }
        };
        const result = turn.then(write);
        const settled = result.then(
            (saved) => {
                if (saved === false) {
                    dropMark();
                }
            },
            dropMark
        );
        this._crmHeldWrites.add(settled);
        settled.then(() => this._crmHeldWrites.delete(settled));
        return result;
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
     * builds. A load started while card writes wait for their turn in the replay
     * (`crmWriteInTurn`) first waits for them, whatever their outcome, so that it
     * reads what they wrote; otherwise it starts at once.
     */
    async load(params = {}) {
        if (this._crmHeldWrites.size) {
            await Promise.all(this._crmHeldWrites);
        }
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
     * A root load given `crmServerGroups: true` lists only the groups the server
     * returns. On a reload of the same search, the framework lists again, emptied,
     * the groups it showed before and the server no longer returns
     * (`config.currentGroups`), so a stage deleted on the server since would stay
     * listed. Those groups are dropped from the configuration of that load only: a
     * load that fails leaves the model's configuration as it was.
     *
     * A root load given `crmStageChoices`, a callback, has its ungrouped request
     * list the stage choices of its search too (`_loadUngroupedList`).
     *
     * Without these options (every framework and desktop load), nothing changes.
     *
     * @param {Object} currentConfig
     * @param {Object} params
     * @returns {Object}
     */
    _getNextConfig(currentConfig, params) {
        const config = super._getNextConfig(...arguments);
        if (params?.crmServerGroups) {
            delete config.currentGroups;
        }
        if (typeof params?.crmStageChoices === "function") {
            this._crmStageChoicesCallbacks.set(config, params.crmStageChoices);
        }
        return config;
    }

    /**
     * @override
     *
     * The first ungrouped request of a root load given `crmStageChoices`
     * (`_getNextConfig`) also asks the server, online, for the stage choices of its
     * search (`CRM_STAGE_CHOICES_KEY` in the context of that request only, never in
     * the model's configuration: other requests, "Load more" included, send what
     * they send without it), so that one request brings the records and those
     * choices. The callback receives the choices the answer lists, or `null` when
     * the load is offline (no flag is sent, so the root is served from the cache
     * as without the option), fails, or its answer lists none. The answer is
     * otherwise used as the framework uses it. The RPC cache keys a request on all
     * its parameters, so this one is cached under a key of its own, which no
     * offline load reads: an offline reload of the search is still served the
     * answer of its last load without the flag.
     *
     * @param {Object} config
     * @param {Object} [cache]
     */
    async _loadUngroupedList(config, cache) {
        const onStageChoices = this._crmStageChoicesCallbacks.get(config);
        if (!onStageChoices) {
            return super._loadUngroupedList(...arguments);
        }
        this._crmStageChoicesCallbacks.delete(config);
        if (this.offlinePlugin.isOffline()) {
            onStageChoices(null);
            return super._loadUngroupedList(...arguments);
        }
        const flagged = {
            ...config,
            context: { ...config.context, [CRM_STAGE_CHOICES_KEY]: true },
        };
        let result;
        try {
            result = await super._loadUngroupedList(flagged, cache);
        } catch (error) {
            onStageChoices(null);
            throw error;
        }
        const stages = result?.[CRM_STAGE_CHOICES_KEY];
        onStageChoices(Array.isArray(stages) ? stages : null);
        return result;
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

export class CrmKanbanRecord extends RelationalModel.Record {
    /**
     * @override
     *
     * A save of a lead (a card's stage move, by drag or by the mobile stage select,
     * its colour, any field a card saves) made while the replay has still to send
     * queued writes of that lead writing one of the saved fields is sent after them
     * (`CrmKanbanModel.crmWriteInTurn`), so that the server keeps the value saved
     * last; a connection reported lost meanwhile does not release it. The record
     * already shows its changes meanwhile. The save then runs as the framework runs
     * it (queued if its request is lost), except that while the connection is
     * reported lost and such a write is still pending, it is queued after that write
     * without being sent (`_crmQueuesSave`). Urgent saves (page close) are never
     * held or queued here, and online with no replay running every save is sent at
     * once.
     */
    _save() {
        if (this.model._urgentSave || this.resModel !== "crm.lead") {
            return super._save(...arguments);
        }
        const args = arguments;
        toRaw(this)._crmSaveQueued = false;
        return this.model.crmWriteInTurn(this, Object.keys(this._changes), () =>
            untrack(() => this._crmQueuesSave())
                ? this._crmQueueSave(() => super._save(...args))
                : super._save(...args)
        );
    }

    /**
     * Whether the save of the lead is queued after its pending queued writes instead
     * of being sent (`_crmQueueSave`).
     *
     * The framework sends a save whatever the connection state, and queues it only
     * when its request is lost. Once the connection is back, it is still reported
     * lost until a request reaches the server: a card save made meanwhile reaches the
     * server, which takes the connection for restored, and the replay then sends the
     * lead's older queued writes of the same fields over it. So, while the connection
     * is reported lost and a pending (not parked) queued write of the lead writes one
     * of the saved fields (`crmPendingLeadWrites`), the save is queued as the
     * framework queues a save whose request is lost (`_offlineSave`), after those
     * writes: the replay sends them first, and the card's values last.
     *
     * Every other save is sent as before: online (the replay turn applies), for a
     * record without an id, for an urgent save (its beacon cannot wait), and while no
     * pending queued write of the lead writes a saved field.
     *
     * @returns {boolean}
     */
    _crmQueuesSave() {
        return (
            Boolean(this.resId) &&
            !this.model._urgentSave &&
            this.model.offlinePlugin.isOffline() &&
            crmPendingLeadWrites(this.model.offlinePlugin, this, Object.keys(this._changes))
                .length > 0
        );
    }

    /**
     * Runs the framework save `save` (`Record._save`) so that the lead's own
     * `web_save` is not sent: the model's ORM fails it at once as a lost connection,
     * before any request, so the framework queues the save (`_offlineSave`), exactly
     * as when its request is lost. Every step before the request runs as it does for
     * any save, and every other call of the model's ORM is sent unchanged meanwhile.
     * A queued save marks the record (`_crmSaveQueued`), so that the stage move it
     * belongs to does no rainbowman lookup, as for any offline move.
     *
     * The request the save would have sent was also what told the framework that the
     * connection is back. Once the save is queued, the plugin checks the connection
     * (`checkConnection`, the check the offline systray offers) instead: when it is
     * back, the replay starts and sends the lead's queued writes, this save last;
     * otherwise nothing changes. The check is not awaited, so the save ends at once.
     *
     * @param {() => Promise<boolean>} save the parent's save
     * @returns {Promise<boolean>} its result
     */
    async _crmQueueSave(save) {
        const model = toRaw(this.model);
        const orm = model.orm;
        const resModel = this.resModel;
        const resId = this.resId;
        let queued = false;
        const queuingOrm = Object.assign(Object.create(orm), {
            webSave(saveModel, resIds) {
                if (saveModel === resModel && resIds?.length === 1 && resIds[0] === resId) {
                    queued = true;
                    return Promise.reject(
                        new ConnectionLostError(`/web/dataset/call_kw/${saveModel}/web_save`)
                    );
                }
                return orm.webSave(...arguments);
            },
        });
        model.orm = queuingOrm;
        try {
            return await save();
        } finally {
            if (model.orm === queuingOrm) {
                model.orm = orm;
            }
            if (queued) {
                toRaw(this)._crmSaveQueued = true;
                model.offlinePlugin.checkConnection();
            }
        }
    }

    /**
     * @override
     *
     * The framework queues every offline save of a record under the key and time
     * stamp of its first one, and replays the queue in time-stamp order. A field this
     * save writes that a pending queued write of the lead stamped since also writes
     * (made through another record of the lead, such as its form) would then replay
     * before that write and lose to it, although the user wrote it last. Such a save
     * is queued as an entry of its own, holding the changes of this save only,
     * stamped after those writes (`_crmOfflineSaveTimeStamp`): the record's earlier
     * queued save, if any, stays as it is, in its place, and the user's card values
     * replay last. Every other offline save is the framework's.
     *
     * @returns {boolean}
     */
    _offlineSave() {
        const timeStamp = untrack(() => this._crmOfflineSaveTimeStamp());
        if (!timeStamp) {
            return super._offlineSave(...arguments);
        }
        const { _offlineId, _offlineChanges, _offlineTimeStamp } = this;
        this._offlineId = undefined;
        this._offlineChanges = undefined;
        this._offlineTimeStamp = timeStamp;
        try {
            return super._offlineSave(...arguments);
        } catch (error) {
            // Nothing was queued (a non-secure origin has no queue): the record keeps
            // its queued save.
            Object.assign(this, { _offlineId, _offlineChanges, _offlineTimeStamp });
            throw error;
        }
    }

    /**
     * Time stamp at which the lead's offline save about to be queued (`_offlineSave`)
     * is queued as an entry of its own: after every pending (not parked) queued write
     * of the lead writing one of the saved fields (`crmPendingLeadWrites`) and stamped
     * with or after the time stamp the framework would give the save (that of the
     * record's queued save, else of its previous one, else now). `0` when there is
     * no such write: the framework's save then replays after every write of those
     * fields already.
     *
     * @returns {number}
     */
    _crmOfflineSaveTimeStamp() {
        if (this.resModel !== "crm.lead" || !this.resId) {
            return 0;
        }
        const plugin = this.model.offlinePlugin;
        const ownKey = this._offlineId;
        const own = ownKey ? plugin._ormToSync()[ownKey] : undefined;
        const saveTimeStamp = own?.value.extras?.timeStamp || this._offlineTimeStamp || Date.now();
        const writes = crmPendingLeadWrites(plugin, this, Object.keys(this._changes));
        let timeStamp = 0;
        for (const { key, value } of writes) {
            const writeTimeStamp = value.extras?.timeStamp || 0;
            if (key !== ownKey && writeTimeStamp >= saveTimeStamp) {
                timeStamp = Math.max(timeStamp, Date.now(), writeTimeStamp + 1);
            }
        }
        return timeStamp;
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
     * raised. A move made during a replay that has still to send queued writes of
     * the lead's stage is saved after them (`CrmKanbanRecord`), and looked up then.
     * A move queued while the connection was still reported lost
     * (`CrmKanbanRecord._crmQueueSave`) is an offline move as well, even once the
     * connection check it started reports the connection back: it is not looked up.
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
            if (!toRaw(record)._crmSaveQueued) {
                await checkRainbowmanMessage(this.model.orm, this.model.effect, record.resId);
            }
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
     * their groups at once, each group decrementing its own count. Online, during a
     * replay that has still to send queued writes of the deleted leads, the delete
     * is sent after them (`deleteTurn`).
     */
    async _deleteRecords(records) {
        const turn = deleteTurn(this, records);
        if (turn) {
            await turn;
        }
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
     * decrementing its own count). Online, `super` reloads the model; during a
     * replay that has still to send queued writes of the deleted leads, the delete
     * is sent after them (`deleteTurn`).
     */
    async _deleteRecords(records) {
        const turn = deleteTurn(this, records);
        if (turn) {
            await turn;
        }
        const res = await super._deleteRecords(...arguments);
        await removeRecordsDeletedOffline(this, records);
        return res;
    }
}

CrmKanbanModel.Record = CrmKanbanRecord;
CrmKanbanModel.DynamicGroupList = CrmKanbanDynamicGroupList;
CrmKanbanModel.DynamicRecordList = CrmKanbanDynamicRecordList;
CrmKanbanModel.services = [...RelationalModel.services, "effect"];
