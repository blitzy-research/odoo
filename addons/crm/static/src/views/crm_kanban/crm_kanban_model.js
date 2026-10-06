import { onWillDestroy, signal, toRaw, untrack } from "@odoo/owl";
import {
    CRM_STAGE_CHOICES_KEY,
    crmContextWithOrigin,
    crmLeadWriteTurn,
    crmPendingLeadWrites,
    crmReplayQueued,
    crmTurnWriteTimeStamp,
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
 * nothing is done, unless the `unlink` was queued instead of sent (`queued`).
 *
 * @param {Object} list `CrmKanbanDynamicRecordList` or `CrmKanbanDynamicGroupList`
 * @param {Object[]} records the records passed to `_deleteRecords`
 * @param {boolean} [queued] the delete was queued without being sent
 *  (`deleteQueued`)
 */
async function removeRecordsDeletedOffline(list, records, queued = false) {
    if (!queued && !list.model.offlinePlugin.isOffline()) {
        return;
    }
    const ids = records.map((r) => r.id).filter((id) => list.records.some((r) => r.id === id));
    if (ids.length) {
        await list._removeRecords(ids);
    }
}

/**
 * Turn of an online delete, from `list`, of leads the replay has still to send
 * queued calls of (`crmLeadWriteTurn`): an `unlink` sent ahead of them would make
 * them fail and park. The leads are the given records, else (a delete of the
 * selection) the selected ones. A connection reported lost, or the end of the view
 * owning the model (`crmDestroyed`), while the delete waits makes it "queue only"
 * (`deleteQueued`).
 *
 * @param {Object} list `CrmKanbanDynamicRecordList` or `CrmKanbanDynamicGroupList`
 * @param {Object[]} records the records passed to `_deleteRecords`
 * @returns {Promise<import("@crm/mobile/crm_offline_hooks").CrmWriteTurn>|undefined}
 *  `undefined` when the delete may be sent now; else resolved at its turn with its
 *  outcome: `queueOnly` set when it is to be queued only, and `origin`, the user who
 *  made it and the database of their session, which it sends otherwise
 */
function deleteTurn(list, records) {
    const targets = records.length ? records : list.selection || [];
    return crmLeadWriteTurn(list.model.offlinePlugin, targets, null, list.model.crmDestroyed);
}

/**
 * Runs the framework delete `deleteRecords` (`DynamicList._deleteRecords`) of leads
 * whose turn in the replay ended "queue only" (`deleteTurn`) so that its `unlink` is
 * not sent: the model's ORM fails it at once as a lost connection, before any
 * request, so the framework queues it, exactly as when its request is lost. As it is
 * queued, before the replay is asked to deliver it, the `unlink` is stamped after
 * every queued call, pending or parked, of each lead it deletes (the CRM
 * `OfflinePlugin.scheduleORM`), whatever time stamps those calls carry: every replay
 * sends them before the `unlink`, including the one that follows when the running
 * replay's request is lost. The replay is then asked to deliver it (`crmReplayQueued`).
 * Every other call of the model's ORM is sent unchanged meanwhile.
 *
 * @param {Object} list `CrmKanbanDynamicRecordList` or `CrmKanbanDynamicGroupList`
 * @param {() => Promise<boolean>} deleteRecords the parent's delete
 * @returns {Promise<boolean>} its result
 */
async function deleteQueued(list, deleteRecords) {
    const model = toRaw(list.model);
    const orm = model.orm;
    let queued = false;
    const queuingOrm = Object.assign(Object.create(orm), {
        unlink(resModel) {
            if (resModel === "crm.lead") {
                queued = true;
                return Promise.reject(
                    new ConnectionLostError(`/web/dataset/call_kw/${resModel}/unlink`)
                );
            }
            return orm.unlink(...arguments);
        },
    });
    model.orm = queuingOrm;
    try {
        return await deleteRecords();
    } finally {
        if (model.orm === queuingOrm) {
            model.orm = orm;
        }
        if (queued) {
            crmReplayQueued(model.offlinePlugin);
        }
    }
}

/**
 * Runs `send`, the framework save or delete of a lead write held for its turn
 * (`crmLeadWriteTurn`), with the model's ORM sending its `method` call of `resModel`
 * (the `web_save` of the lead `resId`, or the `unlink` of the deleted leads, any
 * `resId`) with `origin`, the user who made the write and the database of their
 * session, in its context (`crmContextWithOrigin`): sent at its turn, in another
 * user's session or in a session of another database, it is refused by the server,
 * and its error is handled by the framework as for any refused save or delete. Every other call of the model's ORM is sent unchanged
 * meanwhile, and a request lost meanwhile is queued by the framework as before.
 *
 * @template T
 * @param {Object} model
 * @param {import("@crm/mobile/crm_offline_hooks").CrmWriteOrigin} origin
 * @param {string} resModel
 * @param {string} method
 * @param {number|null} resId the record the call targets alone; `null` for any
 * @param {() => Promise<T>} send
 * @returns {Promise<T>} the result of `send`
 */
async function sendWithOrigin(model, origin, resModel, method, resId, send) {
    const rawModel = toRaw(model);
    const orm = rawModel.orm;
    const originOrm = Object.assign(Object.create(orm), {
        call(callModel, callMethod, args, kwargs) {
            const ids = args?.[0];
            if (
                callModel === resModel &&
                callMethod === method &&
                (resId === null || (ids?.length === 1 && ids[0] === resId))
            ) {
                kwargs = { ...kwargs, context: crmContextWithOrigin(kwargs?.context, origin) };
            }
            return orm.call.call(this, callModel, callMethod, args, kwargs);
        },
    });
    rawModel.orm = originOrm;
    try {
        return await send();
    } finally {
        if (rawModel.orm === originOrm) {
            rawModel.orm = orm;
        }
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
 *
 * A write of a lead from its card (a save, such as a stage move or a colour, or a
 * delete) made while the replay has still to send queued writes of that lead waits
 * for them (`crmWriteInTurn`, `crmLeadWriteTurn`), so that the write made last
 * reaches the server last, and is then sent with the user who made it and the
 * database of their session, which the server checks against the session it reaches
 * (`sendWithOrigin`); a connection reported lost, or the end of the view, while it
 * waits makes it queued after them instead of sent. A card save made while the
 * connection is reported lost and such a write is pending is queued after it as well
 * (`CrmKanbanRecord`). Root loads started meanwhile (`load`), and server answers of
 * cached root loads read before such a write (`_getCacheParams`), give way to it: the
 * root then shows what it saved.
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
        /** Set once the view owning the model is destroyed (`crmWriteInTurn`). */
        this.crmDestroyed = signal(false);
        onWillDestroy(() => this.crmDestroyed.set(true));
        /**
         * Root configurations of loads given `crmStageChoices`, mapped to that
         * callback, until their first ungrouped request (`_loadUngroupedList`).
         *
         * @type {WeakMap<Object, (stages: {id: number, display_name: string}[]|null) => void>}
         */
        this._crmStageChoicesCallbacks = new WeakMap();
        /** @type {number} count of the writes `crmWriteInTurn` has held */
        this._crmHeldWriteCount = 0;
        /** @type {Object|null} token of the root load (`load`) running, if any */
        this._crmRootLoad = null;
    }

    /**
     * Runs `write`, a write of the lead `record` setting `fieldNames`, once the
     * replay has sent (or parked) the pending queued writes of that lead it must
     * follow (any write of a field of the lead), or has ended (`crmLeadWriteTurn`), so
     * that the server keeps the value written last. A connection reported lost, or
     * the destruction of the view owning the model (`crmDestroyed`), with those
     * writes still pending, ends the wait as well. A held write is given the outcome
     * of its turn (`CrmWriteTurn`): with `queueOnly` set (the wait ended so), `write`
     * queues the write after those writes without sending it; otherwise its request
     * sends `origin`, the user who made it and the database of their session, read
     * when the hold starts (`CrmWriteOrigin`, `crmContextWithOrigin`,
     * `sendWithOrigin`). With no replay running, or none of those writes left, `write`
     * runs at once, with no added wait, and is given nothing: it sends its request as
     * before. A held write marks the record (`crmTurnWrite`, which the mobile
     * projections read): its values of `fieldNames` show over every write of the
     * lead queued or replayed when it is made, even one stamped past the clock
     * (`crmTurnWriteTimeStamp`), while it waits and once it is done, until a reload
     * replaces the record; a write that fails or saves nothing (`false`) drops the
     * mark. Root loads started meanwhile wait for the held write (`load`), so that
     * the reload ending a replay reads what it wrote.
     *
     * @template T
     * @param {Object} record
     * @param {string[]} fieldNames
     * @param {(turn?: import("@crm/mobile/crm_offline_hooks").CrmWriteTurn) => Promise<T>} write
     * @returns {Promise<T>}
     */
    crmWriteInTurn(record, fieldNames, write) {
        const turn = crmLeadWriteTurn(this.offlinePlugin, [record], fieldNames, this.crmDestroyed);
        if (!turn) {
            return write();
        }
        const mark = {
            timeStamp: crmTurnWriteTimeStamp(this.offlinePlugin, record),
            fieldNames: [...fieldNames],
        };
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
        this._crmHeldWriteCount++;
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
     * reads what they wrote; otherwise it starts at once. Until the last load
     * started ends, `_crmRootLoad` tells that one is running (a load the framework
     * supersedes never ends), so that a server answer of a cached root load read
     * before held card writes gives way to it (`_crmReloadOverCacheUpdate`).
     */
    async load(params = {}) {
        const rootLoad = {};
        this._crmRootLoad = rootLoad;
        try {
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
        } finally {
            if (this._crmRootLoad === rootLoad) {
                this._crmRootLoad = null;
            }
        }
    }

    /**
     * @override
     *
     * A root load served from the RPC cache gets the server's answer afterwards; the
     * framework sets it on the root when it differs from the cached one (`callback`),
     * rebuilding its groups and records. A card write held in the replay
     * (`crmWriteInTurn`) that is pending when that answer arrives, or was made since
     * the load was requested, may be missing from it: set on the root, the answer
     * would show the lead as it was before the write (a moved card back in its former
     * stage) and drop the held move's records, whose rainbowman lookup and mobile
     * projection follow them. Such an answer is not set: the framework still records
     * the view as available offline and caches the answer's many2x values, as for an
     * unchanged answer, and the root is loaded again once the held writes are done
     * (`_crmReloadOverCacheUpdate`). Every other answer, and every answer while no
     * card write was held, is handled by the framework at once, as before.
     *
     * @param {Object} config
     * @param {Promise<{root: Object, loadId: string}>} rootLoadProm
     * @returns {Object|undefined}
     */
    _getCacheParams(config, rootLoadProm) {
        const params = super._getCacheParams(...arguments);
        if (!params) {
            return params;
        }
        const { callback } = params;
        const firstLoad = !this.isReady();
        const heldWriteCount = this._crmHeldWriteCount;
        params.callback = (result, hasChanged) => {
            if (
                !hasChanged ||
                (!this._crmHeldWrites.size && this._crmHeldWriteCount === heldWriteCount)
            ) {
                return callback(result, hasChanged);
            }
            return this._crmReloadOverCacheUpdate(callback(result, false), rootLoadProm, firstLoad);
        };
        return params;
    }

    /**
     * Ends the handling of a server answer of a cached root load that
     * `_getCacheParams` did not set because of held card writes: once the
     * framework's callback (`handled`, told that the answer is unchanged) and the
     * held writes are done, reloads the root, so that it shows what they saved. The
     * reload only runs where the framework would have set the answer (the root the
     * answer was read for, not replaced nor reloaded since), while online and with
     * no root load running, which reads what the writes saved as well; otherwise
     * the root keeps showing the values the user wrote. As the framework does with
     * the answer of a model's first load, the reload lists only the groups the
     * server returns (`crmServerGroups`), and the view is then rendered, as after the
     * view's own loads (`notify`). A lost connection ends the reload with the root
     * as it was, as the file's other reloads end.
     *
     * @param {Promise<void>} handled
     * @param {Promise<{root: Object, loadId: string}>} rootLoadProm
     * @param {boolean} firstLoad whether the answer is that of the model's first load
     * @returns {Promise<void>}
     */
    async _crmReloadOverCacheUpdate(handled, rootLoadProm, firstLoad) {
        await handled;
        const { root, loadId } = await rootLoadProm;
        if (this._crmHeldWrites.size) {
            await Promise.all(this._crmHeldWrites);
        }
        if (
            root.id !== this.root.id ||
            loadId !== root.config.loadId ||
            this._crmRootLoad ||
            this.offlinePlugin.isOffline()
        ) {
            return;
        }
        try {
            await this.load(firstLoad ? { crmServerGroups: true } : {});
        } catch (error) {
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
            return;
        }
        this.notify();
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
     * queued writes of a field of that lead is sent after them
     * (`CrmKanbanModel.crmWriteInTurn`), so that the server keeps the value saved
     * last. The record already shows its changes meanwhile. The save then runs as
     * the framework runs it (queued if its request is lost), except that it is queued
     * after those writes without being sent (`_crmQueuesSave`) while one of them is
     * still pending and the connection is reported lost, or the wait ended "queue
     * only" (a connection reported lost, or the end of the view, during the wait).
     * Otherwise a held save sends its `web_save` with the user who made it and the
     * database of their session (`sendWithOrigin`). Urgent saves (page close) are
     * never held or queued here, and online with no replay running every save is
     * sent at once, as before.
     */
    _save() {
        if (this.model._urgentSave || this.resModel !== "crm.lead") {
            return super._save(...arguments);
        }
        const args = arguments;
        toRaw(this)._crmSaveQueued = false;
        return this.model.crmWriteInTurn(this, Object.keys(this._changes), (turn) => {
            if (untrack(() => this._crmQueuesSave(Boolean(turn?.queueOnly)))) {
                return this._crmQueueSave(() => super._save(...args));
            }
            if (!turn) {
                return super._save(...args);
            }
            return sendWithOrigin(
                this.model,
                turn.origin,
                this.resModel,
                "web_save",
                this.resId,
                () => super._save(...args)
            );
        });
    }

    /**
     * Whether the save of the lead is queued after its pending queued writes instead
     * of being sent (`_crmQueueSave`).
     *
     * The framework sends a save whatever the connection state, and queues it only
     * when its request is lost. Once the connection is back, it is still reported
     * lost until a request reaches the server: a card save made meanwhile reaches the
     * server, which takes the connection for restored, and the replay then sends the
     * lead's older queued writes over it. So, while the connection is reported lost
     * and a pending (not parked) queued write of a field of the lead remains
     * (`crmPendingLeadWrites`), the save is queued as the framework queues a save
     * whose request is lost (`_offlineSave`), after those writes: the replay sends
     * them first, and the card's values last. A save whose turn ended "queue only"
     * (`force`, `crmWriteInTurn`) is queued so whatever the connection state, while
     * such a write is still pending.
     *
     * Every other save is sent as before: online (the replay turn applies), for a
     * record without an id, for an urgent save (its beacon cannot wait), and while no
     * pending queued write of the lead remains.
     *
     * @param {boolean} [force] the save's turn ended "queue only"
     * @returns {boolean}
     */
    _crmQueuesSave(force = false) {
        return (
            Boolean(this.resId) &&
            !this.model._urgentSave &&
            (force || this.model.offlinePlugin.isOffline()) &&
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
     * connection is back. Once the save is queued, the replay is asked to deliver it
     * instead (`crmReplayQueued`): while the connection is reported lost, the plugin
     * checks it (`checkConnection`, the check the offline systray offers), and when it
     * is back the replay starts and sends the lead's queued writes, this save last;
     * online, the replay starts, or the running one starts the next when it ends.
     * Nothing is awaited, so the save ends at once.
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
                crmReplayQueued(model.offlinePlugin);
            }
        }
    }

    /**
     * @override
     *
     * The framework queues every offline save of a record under the key and time
     * stamp of its first one, and replays the queue in time-stamp order. This save
     * would then replay before a pending queued write of the lead stamped since (made
     * through another record of the lead, such as its form), and lose to it although
     * the user made it last: to its values, or to the fields the server recomputes
     * from them. Such a save is queued as an entry of its own, holding the changes of
     * this save only, stamped after those writes (`_crmOfflineSaveTimeStamp`): the
     * record's earlier queued save, if any, stays as it is, in its place, and the
     * user's card values replay last. Every other offline save is the framework's.
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
     * of a field of the lead (`crmPendingLeadWrites`) stamped with or after the time
     * stamp the framework would give the save (that of the record's queued save, else
     * of its previous one, else now). `0` when there is no such write: the
     * framework's save then replays after every write of the lead already.
     *
     * While a replay runs and the record's own queued save is pending (not parked),
     * the save is an entry of its own as well, stamped after that save and every
     * pending write of the lead: the replay may have read that save already, and it
     * then sends the values it read and removes the entry under its key, whatever the
     * entry holds by then, so values merged into it would be lost.
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
        const ownReplaying = Boolean(own) && !own.value.extras?.error && plugin.syncingORM();
        let timeStamp = ownReplaying ? Math.max(Date.now(), saveTimeStamp + 1) : 0;
        for (const { key, value } of writes) {
            const writeTimeStamp = value.extras?.timeStamp || 0;
            if (ownReplaying || (key !== ownKey && writeTimeStamp >= saveTimeStamp)) {
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
     * The groups and the moved record are read before the move: a root update set
     * while the move is saved can replace this list's groups and records, so the
     * lookup follows the record the user moved. A move the framework reverted (its
     * save saved nothing) moved no lead: it is not looked up.
     */
    async moveRecord(dataRecordId, dataGroupId, refId, targetGroupId) {
        const sourceGroup = this.groups.find((g) => g.id === dataGroupId);
        const targetGroup = this.groups.find((g) => g.id === targetGroupId);
        const record = sourceGroup?.list.records.find((r) => r.id === dataRecordId);
        const isStageMove =
            dataGroupId !== targetGroupId &&
            Boolean(record && targetGroup) &&
            sourceGroup.groupByField.name === "stage_id";
        await super.moveRecord(...arguments);
        if (
            isStageMove &&
            targetGroup.list.records.some((r) => r.id === dataRecordId) &&
            !this.model.offlinePlugin.isOffline() &&
            !toRaw(record)._crmSaveQueued
        ) {
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
     * their groups at once, each group decrementing its own count. Online, during a
     * replay that has still to send queued calls of the deleted leads, the delete
     * is sent after them (`deleteTurn`), with the user who made it and the database
     * of their session (`sendWithOrigin`), or queued after them when its turn ends
     * "queue only" (`deleteQueued`), and the cards are then removed at once as well.
     * A queued `unlink` (offline, its request lost, or queue only) is stamped as it is
     * queued after every queued call, pending or parked, of each lead it deletes, the
     * latest of all of them for several leads (the CRM `OfflinePlugin.scheduleORM`):
     * the replay sends those calls first, even when they are stamped ahead of the
     * clock.
     */
    async _deleteRecords(records) {
        const pending = deleteTurn(this, records);
        const turn = pending && (await pending);
        const del = () => super._deleteRecords(...arguments);
        let res;
        if (turn?.queueOnly) {
            res = await deleteQueued(this, del);
        } else if (turn) {
            res = await sendWithOrigin(this.model, turn.origin, this.resModel, "unlink", null, del);
        } else {
            res = await del();
        }
        await removeRecordsDeletedOffline(this, records, Boolean(turn?.queueOnly));
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
     * replay that has still to send queued calls of the deleted leads, the delete
     * is sent after them (`deleteTurn`), with the user who made it and the database
     * of their session (`sendWithOrigin`), or queued after them when its turn ends
     * "queue only" (`deleteQueued`), and the records are then removed at once as well.
     * A queued `unlink` (offline, its request lost, or queue only) is stamped as it is
     * queued after every queued call, pending or parked, of each lead it deletes, the
     * latest of all of them for several leads (the CRM `OfflinePlugin.scheduleORM`):
     * the replay sends those calls first, even when they are stamped ahead of the
     * clock.
     */
    async _deleteRecords(records) {
        const pending = deleteTurn(this, records);
        const turn = pending && (await pending);
        const del = () => super._deleteRecords(...arguments);
        let res;
        if (turn?.queueOnly) {
            res = await deleteQueued(this, del);
        } else if (turn) {
            res = await sendWithOrigin(this.model, turn.origin, this.resModel, "unlink", null, del);
        } else {
            res = await del();
        }
        await removeRecordsDeletedOffline(this, records, Boolean(turn?.queueOnly));
        return res;
    }
}

CrmKanbanModel.Record = CrmKanbanRecord;
CrmKanbanModel.DynamicGroupList = CrmKanbanDynamicGroupList;
CrmKanbanModel.DynamicRecordList = CrmKanbanDynamicRecordList;
CrmKanbanModel.services = [...RelationalModel.services, "effect"];
