import { toRaw } from "@odoo/owl";
import { checkRainbowmanMessage } from "@crm/views/check_rainbowman_message";
import { ConnectionLostError } from "@web/core/network/rpc";
import { RelationalModel } from "@web/model/relational_model/relational_model";

/**
 * Records, into the model's server-value snapshot, the server stage and expected
 * revenue of raw records just received from the server, for the ids it does not
 * hold yet. The first value kept for an id is therefore the one the group
 * aggregates were computed from: a record moved or edited locally is never
 * re-read, and a later non-root load returning post-save values for it cannot
 * overwrite that value.
 *
 * The target is the map being built by the running root load, or else the
 * current snapshot (a later group toggle or "load more"). Sample data is never
 * recorded: while sample records are displayed (`useSampleModel`) or loaded
 * through the sample ORM, which happens before `useSampleModel` is set.
 *
 * @param {CrmKanbanModel} model
 * @param {Object[]} records raw server records (`data.records` of a list)
 */
function recordCrmServerValues(model, records) {
    if (model.useSampleModel || model.orm?.isSample) {
        return;
    }
    const target = model._crmLoadingServerValues || model.crmServerValues;
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
 * - `crmServerValues` is a `Map<number, {stageId: number|false, revenue: number|undefined}>`
 *   holding, per lead id, the server stage and expected revenue from the last
 *   successful root load, plus the leads of later group loads. It is an in-memory
 *   arithmetic snapshot, not a cache: it persists nothing and serves no read.
 *   `CrmMobilePipeline` reads it to compute the header revenue delta of the
 *   leads moved or edited since the server computed the group aggregates.
 * - `_crmLoadingServerValues` is the map being filled while a root load runs
 *   (`null` otherwise); it becomes `crmServerValues` only if that load succeeds,
 *   so a failed offline load keeps the previous snapshot.
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
        // Assigned here rather than as class fields: `Model`'s constructor runs
        // `setup` (including subclasses' such as ForecastKanbanModel) before any
        // class field of this class would be initialised.
        this.crmServerValues = new Map();
        this._crmLoadingServerValues = null;
    }

    /**
     * @override
     *
     * Fills a fresh server-value snapshot during the root load and makes it the
     * current one only when the load succeeds. Offline, a root load of the mobile
     * variant that could not be served is retried once when the
     * `crmUseDesktopSpec` hook asks for it (the hook switches to the desktop
     * variant); the error of that retry propagates as the framework raises it.
     */
    async load(params = {}) {
        const next = new Map();
        this._crmLoadingServerValues = next;
        try {
            try {
                await super.load(...arguments);
            } catch (error) {
                if (!(error instanceof ConnectionLostError) || !this.hooks.crmUseDesktopSpec?.()) {
                    throw error;
                }
                next.clear();
                await super.load(...arguments);
            }
            this.crmServerValues = next;
        } finally {
            // An overlapping, more recent load owns the loading map: leave it alone.
            // Compared raw, as the model may be called through a reactive proxy.
            if (toRaw(this._crmLoadingServerValues) === next) {
                this._crmLoadingServerValues = null;
            }
        }
    }

    /**
     * Runs `fn`, which sets fresh server data on the current root outside a root
     * load (the disk-cache update of a load that already resolved, or a root
     * `_updateConfig` reload), with a fresh snapshot map, then makes that map the
     * current snapshot. The loading map of an in-flight `load()` is restored, so
     * that load still swaps its own map in when it succeeds.
     *
     * @param {() => void} fn
     */
    _crmWithFreshServerValues(fn) {
        const previous = this._crmLoadingServerValues;
        const next = new Map();
        this._crmLoadingServerValues = next;
        try {
            fn();
        } finally {
            this._crmLoadingServerValues = previous;
        }
        this.crmServerValues = next;
    }
}

export class CrmKanbanDynamicGroupList extends RelationalModel.DynamicGroupList {
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
     * Fresh server data set on the current grouped root outside a root load
     * replaces the server-value snapshot: the groups, and with them every group's
     * record list, are built synchronously by `super`.
     */
    _setData(data) {
        if (this.config.isRoot && isCurrentRoot(this)) {
            this.model._crmWithFreshServerValues(() => super._setData(...arguments));
        } else {
            super._setData(...arguments);
        }
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
     * Records the server stage and revenue of the received records (see
     * `recordCrmServerValues`) before `super` builds the record datapoints. Fresh
     * server data set on the current ungrouped root outside a root load replaces
     * the snapshot.
     */
    _setData(data) {
        if (this.config.isRoot && isCurrentRoot(this)) {
            this.model._crmWithFreshServerValues(() => {
                recordCrmServerValues(this.model, data.records);
                super._setData(...arguments);
            });
        } else {
            recordCrmServerValues(this.model, data.records);
            super._setData(...arguments);
        }
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
