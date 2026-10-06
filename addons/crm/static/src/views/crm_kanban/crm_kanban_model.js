import { onWillDestroy, signal, toRaw, untrack } from "@odoo/owl";
import {
    CRM_STAGE_CHOICES_KEY,
    crmContextWithOrigin,
    crmLeadWriteTurn,
    crmOwnEffectPromise,
    crmPendingLeadWrites,
    crmReplayQueued,
    crmReportError,
    crmTurnWriteTimeStamp,
} from "@crm/mobile/crm_offline_hooks";
import { checkRainbowmanMessage } from "@crm/views/check_rainbowman_message";
import { serializeDate, serializeDateTime } from "@web/core/l10n/dates";
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
 * The values of `fieldNames` that a lead record shows when a save of them is held for
 * its turn in the replay (`CrmKanbanModel.crmHoldWrite`), in the format the server
 * reads them in, the one `Record._applyValues` takes: so that a datapoint of the lead
 * built meanwhile from server data, which the save has not reached yet, shows them
 * too (`CrmKanbanModel._crmShowHeldSaves`). A many2one value is copied, a date or
 * datetime serialized. A field whose value a datapoint cannot take so (one2many,
 * many2many, properties, reference), which no card saves, is left out.
 *
 * @param {Object} record
 * @param {string[]} fieldNames
 * @returns {Object}
 */
function heldSaveValues(record, fieldNames) {
    const { data, fields } = toRaw(record);
    const values = {};
    for (const fieldName of fieldNames) {
        const field = fields[fieldName];
        if (!field || !(fieldName in data)) {
            continue;
        }
        const value = data[fieldName];
        switch (field.type) {
            case "one2many":
            case "many2many":
            case "properties":
            case "reference":
            case "many2one_reference":
                break;
            case "date":
                values[fieldName] = value ? serializeDate(value) : false;
                break;
            case "datetime":
                values[fieldName] = value ? serializeDateTime(value) : false;
                break;
            case "many2one":
                values[fieldName] = value ? { ...value } : false;
                break;
            default:
                values[fieldName] = value;
        }
    }
    return values;
}

/**
 * Whether `group` holds the records whose value of its group-by field is `value`, in
 * a record's format: the many2one id, the date or datetime in the group's range (no
 * value in the group without one), any other value equal to the group's. `undefined`
 * when the grouping cannot tell (a many2many or tags field, whose record is in a group
 * per value, or no group-by field).
 *
 * @param {Object} group
 * @param {any} value
 * @returns {boolean|undefined}
 */
function groupHoldsValue(group, value) {
    switch (group.groupByField?.type) {
        case undefined:
        case "many2many":
        case "tags":
            return undefined;
        case "many2one":
            return group.value === (value ? value.id : false);
        case "date":
        case "datetime":
            if (!group.range) {
                return !value && !group.value;
            }
            return Boolean(value) && value >= group.range.from && value < group.range.to;
        default:
            return group.value === value;
    }
}

/**
 * Offline, the framework queues the `unlink` of deleted records and returns
 * without removing them from the list. This removes the given records that the
 * list still holds, so that their cards disappear at once and the counts drop.
 * Ids are datapoint ids, not `resId`s. A delete of a selection (no `records`)
 * has nothing to remove here. Online, the delete has reloaded the model, so
 * nothing is done, unless the `unlink` was queued instead of sent (`queued`), or
 * waits for its turn in the replay (`deleteInTurn`, which gives the records it
 * deletes, the selected ones included).
 *
 * @param {Object} list `CrmKanbanDynamicRecordList` or `CrmKanbanDynamicGroupList`
 * @param {Object[]} records the records passed to `_deleteRecords`
 * @param {boolean} [queued] the delete was queued without being sent
 *  (`deleteQueued`), or waits for its turn (`deleteInTurn`)
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
 * Delete, from `list` (`deleteRecords`), of `records`, else of the selected records,
 * whose leads the replay has still to send queued calls of (`deleteTurn`): it waits
 * for its turn outside the model's mutex, so that the confirmation asking for it
 * ends at once, as the card's other writes do. The deleted cards are removed at once,
 * in an action of the mutex of their own, each group decrementing its count. At its
 * turn, once the held writes of those records are done (a card save made before the
 * delete is sent before it), the framework delete `del` of those records runs in an
 * action of the mutex of its own (`CrmKanbanModel.crmExecHeld`): queued only after the
 * leads' queued calls when the turn ended so (`deleteQueued`), sent with the user who
 * made it and the database of their session otherwise (`sendWithOrigin`), whose
 * reload of the model then shows the server's records. The delete is tracked as a held
 * write (`_crmTrackHeldWrite`), so that the root loads started meanwhile and the server
 * answers of cached root loads give way to it, and do not show the deleted cards
 * again. A load that cannot give way to it (one run in another action of the mutex,
 * such as the reload of a delete sent at once) reads the leads from the server before
 * the delete is sent: until the delete ends, every list built or loaded meanwhile
 * leaves them out (`CrmKanbanModel._crmHideHeldDelete`), each group then counting
 * them out as well. A delete the server refuses, or that deletes nothing (`false`),
 * stops hiding them, then shows the cards again by reloading the root while online
 * (as the file's other reloads, `notify`), and its error is handed, unchanged, to the
 * framework's error handling (`crmReportError`); a lost request is queued by the
 * framework, the cards staying removed, as for any delete queued offline.
 *
 * A delete of a selection made of the whole domain (`isDomainSelected`), whose
 * records the framework reads from the server at its run, is not held here.
 *
 * @param {Object} list `CrmKanbanDynamicRecordList` or `CrmKanbanDynamicGroupList`
 * @param {Object[]} records the records given to `deleteRecords`
 * @param {(records: Object[]) => Promise<boolean>} del the framework delete
 *  (`DynamicList._deleteRecords`) of the given records
 * @returns {Promise<boolean>|undefined} `undefined` when the delete need not wait (the
 *  framework's `deleteRecords` then runs it); else resolved once the cards are removed
 */
function deleteInTurn(list, records, del) {
    if (!records.length && list.isDomainSelected) {
        return undefined;
    }
    const turn = deleteTurn(list, records);
    if (!turn) {
        return undefined;
    }
    const targets = records.length ? records : list.selection;
    const model = list.model;
    const removed = model.mutex.exec(() => removeRecordsDeletedOffline(list, targets, true));
    const running = { isSave: false };
    const result = Promise.all([turn, removed]).then(async ([outcome]) => {
        await Promise.all(targets.map((record) => toRaw(record)._crmHeldWrite));
        return model.crmExecHeld(running, () =>
            outcome.queueOnly
                ? deleteQueued(list, () => del(targets))
                : sendWithOrigin(model, outcome.origin, list.resModel, "unlink", null, () =>
                      del(targets)
                  )
        );
    });
    running.settled = result.then(
        () => {},
        () => {}
    );
    model._crmTrackHeldWrite(running.settled);
    const endHiding = model._crmHideHeldDelete(targets, running.settled);
    crmOwnEffectPromise(
        result.then(
            (deleted) => {
                endHiding();
                return deleted === false && restoreDeletedCards(model);
            },
            (error) => {
                endHiding();
                crmReportError(error);
                return restoreDeletedCards(model);
            }
        )
    );
    return removed.then(() => true);
}

/**
 * Shows again the cards of a held delete that deleted nothing (`deleteInTurn`): the
 * root is loaded again, then the view rendered (`notify`), while online and while the
 * view owning the model is not destroyed (`crmDestroyed`). A lost connection ends the
 * reload with the root as it was.
 *
 * @param {Object} model
 * @returns {Promise<void>}
 */
async function restoreDeletedCards(model) {
    if (model.crmDestroyed() || model.offlinePlugin.isOffline()) {
        return;
    }
    try {
        await model.load();
    } catch (error) {
        if (!(error instanceof ConnectionLostError)) {
            throw error;
        }
        return;
    }
    model.notify();
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
 * (`CrmKanbanRecord`). A card save or delete waits outside the model's mutex
 * (`CrmKanbanRecord.update`, `deleteInTurn`), then runs in an action of its own
 * (`crmExecHeld`): the pipeline's other card writes, of leads the replay has nothing
 * to send before, and its loads go on meanwhile. A card save decides whether it waits
 * in its action of the mutex, so that a save made before a replay starts and run once
 * it has started waits outside the mutex as well. The card already shows the save,
 * and a deleted card is removed at once. Root loads started meanwhile (`load`), and
 * server answers of cached root loads read before such a write (`_getCacheParams`),
 * give way to it: the root then shows what it saved. A load that cannot give way to
 * it (one run in another action of the mutex) reads the server before the write is
 * sent: every list built or loaded while the write is held still shows it, the
 * deleted leads left out (`_crmHideHeldDelete`) and the values a held save writes
 * shown on the lead's records (`_crmShowHeldSaves`, `_crmPlaceHeldSaves`), until the
 * root is loaded again once the write is done (`_crmReloadAfterHeldWrites`).
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
        /**
         * The held lead write running in the model's mutex (`crmExecHeld`), if any.
         *
         * @type {{isSave: boolean, settled?: Promise<void>}|null}
         */
        this._crmRunningHeld = null;
        /**
         * The lead saves held for their turn and not done yet (`crmHoldWrite`), in the
         * order they were held: the lead, the values the save writes as the server
         * reads them (`heldSaveValues`), the record's mark (`crmTurnWrite`), the
         * records showing them (the held one, and those `_crmShowHeldSaves` built
         * since) and the settlement of the save.
         *
         * @type {Set<{resId: number, values: Object, mark: Object, shownOn: Set<Object>, settled?: Promise<void>}>}
         */
        this._crmHeldSaves = new Set();
        /**
         * The card deletes held for their turn and not done yet (`_crmHideHeldDelete`):
         * the `resId`s of the leads each deletes, and its settlement.
         *
         * @type {Set<{resIds: Set<number>, settled: Promise<void>}>}
         */
        this._crmHeldDeletes = new Set();
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
     * mark. Root loads started meanwhile give way to the held write (`load`), so that
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
        return this.crmHoldWrite(record, fieldNames, turn, write);
    }

    /**
     * Holds `write`, a write of the lead `record` setting `fieldNames`, until `turn`
     * (`crmLeadWriteTurn`, pending) gives it its outcome, then runs it with that
     * outcome, as `crmWriteInTurn` describes: the record is marked (`crmTurnWrite`)
     * meanwhile, the mark is dropped when the write fails or saves nothing (`false`),
     * and the hold is tracked (`_crmTrackHeldWrite`) on the model and on the record
     * (`_crmHeldWrite`), so that root loads and a delete of the lead made meanwhile
     * give way to it. Nothing is awaited here: the caller decides where it waits, so
     * that a card save held outside the model's mutex (`CrmKanbanRecord.update`)
     * leaves the mutex free for the pipeline's other writes and loads while it waits.
     *
     * Until it is done, the write's values of `fieldNames`, as the record shows them,
     * and its mark are kept (`_crmHeldSaves`), so that the lead's records built
     * meanwhile from server data the write has not reached show them as well
     * (`_crmShowHeldSaves`); the mark is then dropped from those records too when the
     * write fails or saves nothing. A record already carrying the mark of a held write
     * not done yet (a record built meanwhile shows it) keeps showing the fields of that
     * mark: the new mark names them as well.
     *
     * @template T
     * @param {Object} record
     * @param {string[]} fieldNames
     * @param {Promise<import("@crm/mobile/crm_offline_hooks").CrmWriteTurn>} turn
     * @param {(turn: import("@crm/mobile/crm_offline_hooks").CrmWriteTurn) => Promise<T>} write
     * @returns {Promise<T>} the result of `write`
     */
    crmHoldWrite(record, fieldNames, turn, write) {
        const model = toRaw(this);
        const carried = toRaw(record.crmTurnWrite);
        const carriedFields =
            carried && [...model._crmHeldSaves].some((held) => held.mark === carried)
                ? carried.fieldNames
                : [];
        const mark = {
            timeStamp: crmTurnWriteTimeStamp(this.offlinePlugin, record),
            fieldNames: [...new Set([...fieldNames, ...carriedFields])],
        };
        record.crmTurnWrite = mark;
        const held = {
            resId: record.resId,
            values: heldSaveValues(record, fieldNames),
            mark,
            shownOn: new Set([record]),
        };
        model._crmHeldSaves.add(held);
        const end = (failed) => {
            model._crmHeldSaves.delete(held);
            if (!failed) {
                return;
            }
            for (const shown of held.shownOn) {
                if (toRaw(shown.crmTurnWrite) === mark) {
                    shown.crmTurnWrite = undefined;
                }
            }
        };
        const result = turn.then(write);
        const settled = result.then(
            (saved) => end(saved === false),
            () => end(true)
        );
        held.settled = settled;
        this._crmTrackHeldWrite(settled);
        toRaw(record)._crmHeldWrite = settled;
        return result;
    }

    /**
     * Hides the leads of `records`, whose card delete waits for its turn in the replay
     * (`deleteInTurn`), from every list built or loaded from server data until the
     * returned function is called (`_crmWithoutHeldDeletes`): such data, read before
     * the delete is sent, still holds them.
     *
     * @param {Object[]} records
     * @param {Promise<void>} settled the settlement of the delete
     * @returns {() => void} ends the hiding
     */
    _crmHideHeldDelete(records, settled) {
        const model = toRaw(this);
        const held = {
            resIds: new Set(records.map((record) => record.resId).filter(Boolean)),
            settled,
        };
        model._crmHeldDeletes.add(held);
        return () => {
            model._crmHeldDeletes.delete(held);
        };
    }

    /**
     * Settlements of the held card writes not done yet that the lists built now still
     * show (`_crmHeldSaves`, `_crmHeldDeletes`): a root built now is loaded again once
     * they are done (`load`).
     *
     * @returns {Promise<void>[]}
     */
    _crmShownHeldWrites() {
        const model = toRaw(this);
        return [...model._crmHeldSaves, ...model._crmHeldDeletes].map(({ settled }) => settled);
    }

    /**
     * `data`, the server data of a list (`{records, length}`) or of a group of records
     * (`{records, length, count, ...}`), without the leads a held card delete hides
     * (`_crmHideHeldDelete`), its `length` and `count` lowered as many: a copy, the
     * server data is left as it is. `data` itself when it holds none of them, and on
     * sample data.
     *
     * @param {Object} data
     * @returns {Object}
     */
    _crmWithoutHeldDeletes(data) {
        const model = toRaw(this);
        if (
            !model._crmHeldDeletes.size ||
            model.useSampleModel ||
            model.orm?.isSample ||
            !Array.isArray(data?.records)
        ) {
            return data;
        }
        const deleted = [...model._crmHeldDeletes];
        const records = data.records.filter(
            (rec) => !deleted.some(({ resIds }) => resIds.has(rec?.id))
        );
        const hidden = data.records.length - records.length;
        if (!hidden) {
            return data;
        }
        const shown = { ...data, records };
        if (typeof data.length === "number") {
            shown.length = data.length - hidden;
        }
        if (typeof data.count === "number") {
            shown.count = data.count - hidden;
        }
        return shown;
    }

    /**
     * The held saves not done yet of the lead `resId`, in the order they were held.
     *
     * @param {number|false} resId
     * @returns {Object[]} entries of `_crmHeldSaves`
     */
    _crmHeldSavesOf(resId) {
        return resId ? [...toRaw(this)._crmHeldSaves].filter((held) => held.resId === resId) : [];
    }

    /**
     * Shows, on the records of `list` just built from server data, the values of the
     * held saves of their leads not done yet (`_crmHeldSaves`), which that data may
     * not hold: they are applied as values of the record (`_applyValues`), so that it
     * shows them without being dirty or saving anything, the latest last. The record
     * carries the mark of the lead's latest held save (`crmTurnWrite`) and its
     * settlements (`_crmHeldWrite`, which a delete of the lead waits for). Nothing is
     * done on sample data.
     *
     * @param {Object} list a `CrmKanbanDynamicRecordList`
     */
    _crmShowHeldSaves(list) {
        const model = toRaw(this);
        if (!model._crmHeldSaves.size || model.useSampleModel || model.orm?.isSample) {
            return;
        }
        for (const record of list.records) {
            const held = this._crmHeldSavesOf(record.resId);
            if (!held.length) {
                continue;
            }
            record._applyValues(Object.assign({}, ...held.map(({ values }) => values)));
            record.crmTurnWrite = held.at(-1).mark;
            toRaw(record)._crmHeldWrite = Promise.all(held.map(({ settled }) => settled)).then(
                () => {}
            );
            for (const { shownOn } of held) {
                shownOn.add(record);
            }
        }
    }

    /**
     * Places, in the groups of `list` just built from server data, the records whose
     * held save not done yet writes the group-by field (`_crmShowHeldSaves` shows its
     * value): a record a group holds although its value is another group's is moved
     * to the top of that group, as a card move puts it there before saving
     * (`DynamicGroupList.moveRecord`), each group counting it as it moves. A record
     * whose value no group holds, or a grouping that cannot tell
     * (`groupHoldsValue`), stays where the server put it.
     *
     * @param {Object} list a `CrmKanbanDynamicGroupList`
     */
    _crmPlaceHeldSaves(list) {
        const model = toRaw(this);
        const fieldName = list.groupByField?.name;
        if (
            !model._crmHeldSaves.size ||
            !fieldName ||
            model.useSampleModel ||
            model.orm?.isSample
        ) {
            return;
        }
        for (const group of [...list.groups]) {
            if (group.list.isGrouped) {
                continue;
            }
            for (const record of [...group.list.records]) {
                if (!this._crmHeldSavesOf(record.resId).some(({ values }) => fieldName in values)) {
                    continue;
                }
                const value = record.data[fieldName];
                if (groupHoldsValue(group, value) !== false) {
                    continue;
                }
                const target = list.groups.find((other) => groupHoldsValue(other, value));
                if (!target || target.list.isGrouped) {
                    continue;
                }
                group._removeRecords([record.id]);
                if (!target.list.records.some((other) => other.resId === record.resId)) {
                    target._addRecord(record, 0);
                }
            }
        }
    }

    /**
     * Keeps in place, in `list`, the list of a group of the current root just loaded
     * again from server data (a "Load more", the reload of the group a card move
     * left), the leads whose held save not done yet writes the group-by field: that
     * data still places them by the value they had. A record whose shown value
     * (`_crmShowHeldSaves`) another group of the root holds and shows (a card move, or
     * `_crmPlaceHeldSaves`, put it there) is left out of `list`, so that the lead is not
     * shown twice. A record of `previous`, the records `list` showed before, whose
     * shown value the group holds and that the data left out is shown again at its
     * place. Only the list's own count changes: the group already counts the lead
     * where it shows.
     *
     * @param {Object} list a `CrmKanbanDynamicRecordList`
     * @param {Object[]} previous the records `list` showed before the data was set
     */
    _crmKeepHeldPlaces(list, previous) {
        const model = toRaw(this);
        const root = model.root;
        const fieldName = root?.groupByField?.name;
        if (
            !model._crmHeldSaves.size ||
            !fieldName ||
            !Array.isArray(root.groups) ||
            model.useSampleModel ||
            model.orm?.isSample
        ) {
            return;
        }
        const holder = root.groups.find((group) => toRaw(group.list) === toRaw(list));
        if (!holder) {
            return;
        }
        const movesLead = (record) =>
            this._crmHeldSavesOf(record.resId).some(({ values }) => fieldName in values);
        const shownElsewhere = (record) =>
            root.groups.some(
                (group) =>
                    group !== holder &&
                    group.list.records.some((other) => other.resId === record.resId)
            );
        const dropped = list.records.filter(
            (record) =>
                movesLead(record) &&
                groupHoldsValue(holder, record.data[fieldName]) === false &&
                shownElsewhere(record)
        );
        if (dropped.length) {
            list._removeRecords(dropped.map(({ id }) => id));
        }
        previous.forEach((record, index) => {
            if (
                movesLead(record) &&
                groupHoldsValue(holder, record.data[fieldName]) === true &&
                !list.records.some((other) => other.resId === record.resId)
            ) {
                list._addRecord(record, Math.min(index, list.records.length));
            }
        });
    }

    /**
     * Tracks a lead write held for its turn in the replay (a card save, a stage choice
     * or a card delete) until `settled`, its settlement, which never rejects: the root
     * loads started meanwhile (`load`) and the server answers of cached root loads
     * (`_getCacheParams`) give way to it.
     *
     * @param {Promise<void>} settled
     */
    _crmTrackHeldWrite(settled) {
        this._crmHeldWrites.add(settled);
        this._crmHeldWriteCount++;
        settled.then(() => this._crmHeldWrites.delete(settled));
    }

    /**
     * Runs `fn`, a lead write held for its turn in the replay and now due, in its own
     * action of the model's mutex, as the framework runs the write it belongs to (a
     * record save, a list delete), after the actions queued before it. `running`
     * (`_crmRunningHeld`) describes it while it runs: a held save never
     * loads the root, so a root load started meanwhile runs outside the mutex and may
     * wait for the held writes; a held delete does load it, inside its action
     * (`DynamicList._deleteRecords`), and that load must not wait for the held writes,
     * which need the mutex, nor for the delete's own settlement (`settled`), which
     * needs the load (`load`).
     *
     * @template T
     * @param {{isSave: boolean, settled?: Promise<void>}} running
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>} the result of `fn`
     */
    crmExecHeld(running, fn) {
        const model = toRaw(this);
        return model.mutex.exec(async () => {
            model._crmRunningHeld = running;
            try {
                return await fn();
            } finally {
                if (model._crmRunningHeld === running) {
                    model._crmRunningHeld = null;
                }
            }
        });
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
     * (`crmHoldWrite`) first waits for them, whatever their outcome, so that it
     * reads what they wrote; otherwise it starts at once. A held card save or delete
     * runs in the model's mutex at its turn (`crmExecHeld`), and the framework loads
     * the root inside its own mutex actions (a delete, a duplicate, an archive): a
     * load started while the mutex runs any action but a held save (which never loads
     * the root) may be that action's own, and waiting would never end. Such a load
     * starts at once, and the root it builds from the server's data, which the held
     * writes have not reached, still shows them (`_crmShowHeldSaves`,
     * `_crmPlaceHeldSaves`, `_crmWithoutHeldDeletes`). The root is loaded again once
     * the held writes pending at its start, and those it shows, are done (but the
     * running held delete, whose own reload it is: `_crmReloadAfterHeldWrites`). Until
     * the last load started ends, `_crmRootLoad` tells that one is running (a load the
     * framework supersedes never ends), so that a server answer of a cached root load
     * read before held card writes gives way to it (`_crmReloadOverCacheUpdate`).
     */
    async load(params = {}) {
        // The token is kept and compared raw: read through the model's reactive proxy
        // (a load a datapoint starts), it would be a proxy of itself.
        const model = toRaw(this);
        const rootLoad = {};
        model._crmRootLoad = rootLoad;
        const running = this._crmRunningHeld;
        const heldWrites = [];
        try {
            if (this._crmHeldWrites.size) {
                if (!this.mutex._queueSize || running?.isSave) {
                    await Promise.all(this._crmHeldWrites);
                } else {
                    heldWrites.push(
                        ...[...this._crmHeldWrites].filter((held) => held !== running?.settled)
                    );
                }
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
            if (model._crmRootLoad === rootLoad) {
                model._crmRootLoad = null;
            }
        }
        for (const held of this._crmShownHeldWrites()) {
            if (held !== running?.settled && !heldWrites.includes(held)) {
                heldWrites.push(held);
            }
        }
        if (heldWrites.length) {
            crmOwnEffectPromise(this._crmReloadAfterHeldWrites(heldWrites, this.root));
        }
    }

    /**
     * Ends a root load that did not wait for the held card writes pending at its
     * start, or that shows held card writes not done when it was built (`load`),
     * `heldWrites`, and loaded `root`: once they are done, the root is
     * loaded again, so that it shows what they wrote, and the view is then rendered,
     * as after the view's own loads (`notify`). The reload only runs while `root` is
     * still the model's root, no root load is running (which reads what they wrote as
     * well), the view owning the model is not destroyed (`crmDestroyed`) and the
     * connection is up; otherwise the root keeps what it shows. A lost connection ends
     * the reload with the root as it was, as the file's other reloads end.
     *
     * @param {Promise<void>[]} heldWrites settlements of the held writes
     * @param {Object} root the root the load built
     * @returns {Promise<void>}
     */
    async _crmReloadAfterHeldWrites(heldWrites, root) {
        await Promise.all(heldWrites);
        if (
            root?.id !== this.root?.id ||
            this._crmRootLoad ||
            this.crmDestroyed() ||
            this.offlinePlugin.isOffline()
        ) {
            return;
        }
        try {
            await this.load();
        } catch (error) {
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
            return;
        }
        this.notify();
    }

    /**
     * @override
     *
     * A root load served from the RPC cache gets the server's answer afterwards; the
     * framework sets it on the root when it differs from the cached one (`callback`),
     * rebuilding its groups and records. A card write held in the replay
     * (`crmHoldWrite`, `deleteInTurn`) that is pending when that answer arrives, or was
     * made since the load was requested, may be missing from it: set on the root, the
     * answer would show the lead as it was before the write (a moved card back in its
     * former stage, a deleted card again) and drop the held move's records, whose
     * rainbowman lookup and mobile projection follow them. Such an answer is not set:
     * the framework still records the view as available offline and caches the
     * answer's many2x values, as for an unchanged answer, and the root is loaded again
     * once the held writes are done (`_crmReloadOverCacheUpdate`). Every other answer,
     * and every answer while no card write was held, is handled by the framework at
     * once, as before.
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
     *
     * A save held here keeps the action of the model's mutex it runs in until its
     * turn. The card saves of a lead, made through `update` and `save`, never wait
     * here: those decide in their action whether the save waits, and hold it outside
     * the mutex (`_crmHoldSave`), so that by the time they call this, in the same
     * synchronous step, the save has nothing to wait for. This hold serves the
     * other callers, such as the retry of a save the framework's error dialog offers,
     * which runs outside the mutex.
     */
    _save() {
        if (this.model._urgentSave || this.resModel !== "crm.lead") {
            return super._save(...arguments);
        }
        const args = arguments;
        toRaw(this)._crmSaveQueued = false;
        return this.model.crmWriteInTurn(this, Object.keys(this._changes), (turn) =>
            this._crmSaveAtTurn(turn, args)
        );
    }

    /**
     * The framework save (`Record._save`) of the lead given `args`, run at the turn
     * of the save in the replay, `turn` (`crmLeadWriteTurn`; `undefined` for a save
     * that waited for nothing): queued after the lead's pending queued writes without
     * being sent (`_crmQueueSave`) while one remains and the connection is reported
     * lost or the turn ended "queue only" (`_crmQueuesSave`); otherwise sent, with the
     * user who made it and the database of their session when it was held
     * (`sendWithOrigin`), as is when it was not.
     *
     * @param {import("@crm/mobile/crm_offline_hooks").CrmWriteTurn|undefined} turn
     * @param {ArrayLike<any>} args the arguments of the save
     * @returns {Promise<boolean>} the result of the framework save
     */
    _crmSaveAtTurn(turn, args) {
        if (untrack(() => this._crmQueuesSave(Boolean(turn?.queueOnly)))) {
            return this._crmQueueSave(() => super._save(...args));
        }
        if (!turn) {
            return super._save(...args);
        }
        return sendWithOrigin(this.model, turn.origin, this.resModel, "web_save", this.resId, () =>
            super._save(...args)
        );
    }

    /**
     * @override
     *
     * A card save of a lead (a stage move, by drag or by the mobile stage select, a
     * colour, any field a card saves on update) runs, as in the framework, in an
     * action of the model's mutex, which applies the changes, so that the card shows
     * them at once, and saves them. Whether the save waits is decided in that action,
     * when it runs, not when the update is made: an update made before a replay starts
     * may run once it has started. When the replay has still to send queued writes of
     * a field of the lead, the save waits for its turn (`_crmHoldSave`) outside that
     * action, which ends at once: the pipeline's other writes, such as the card saves
     * of leads the replay has nothing to send before, which are sent at once, and its
     * loads go on meanwhile. At its turn the save runs in an action of its own
     * (`CrmKanbanModel.crmExecHeld`). The returned promise resolves with the save's
     * result once it is done, so that a stage move the save refuses is undone by the
     * framework (`DynamicGroupList.moveRecord`). Further updates of the record while
     * it waits apply at once as well; the first save done at the turn saves all of
     * them, and the later ones find nothing left to save.
     *
     * A save that need not wait, which is every save with no replay running, runs in
     * the action exactly as the framework's update runs it (the changes applied, then
     * `_save`): the same requests, in the same order; only the returned promise
     * resolves a microtask later. For an urgent save (page close) and for any other
     * model, the framework's update runs, unchanged.
     *
     * @param {Object} changes
     * @returns {Promise<boolean|undefined>}
     */
    update(changes) {
        if (!this._crmMayHoldSave()) {
            return super.update(...arguments);
        }
        let held;
        const applied = this.model.mutex.exec(async () => {
            const save = !this.isInEdition && this.canSaveOnUpdate;
            await this._update(changes, { withoutOnchange: save });
            if (!save) {
                return;
            }
            held = this._crmHoldSave([]);
            if (!held) {
                return this._save();
            }
        });
        return applied.then((result) => (held ? held : result));
    }

    /**
     * @override
     *
     * Decided in its action of the model's mutex, as for a card save on update
     * (`update`): when the replay has still to send queued writes of a field of the
     * lead, the save waits for its turn outside the mutex (`_crmHoldSave`), and
     * resolves with its result once done. A save that need not wait, which is every
     * save with no replay running, runs as the framework's save runs it (the
     * changes asked, then `_save` in the action), its promise resolving a microtask
     * later. For an urgent save and for any other model, the framework's save runs,
     * unchanged.
     *
     * @param {Object} [options]
     * @returns {Promise<boolean>}
     */
    save(options) {
        if (!this._crmMayHoldSave()) {
            return super.save(...arguments);
        }
        return this._crmSaveOutsideMutex(arguments);
    }

    /**
     * The framework's save (`Record.save`) of the lead given `args`, its save held
     * outside the model's mutex until its turn when it has to wait (`_crmHoldSave`).
     *
     * @param {ArrayLike<any>} args the arguments of the save
     * @returns {Promise<boolean>}
     */
    async _crmSaveOutsideMutex(args) {
        await this.model._askChanges();
        let held;
        const saved = await this.model.mutex.exec(() => {
            held = this._crmHoldSave(args);
            if (!held) {
                return this._save(...args);
            }
        });
        return held ? held : saved;
    }

    /**
     * Whether a save of the record goes through the CRM `update` and `save`, which
     * decide in their action of the model's mutex whether it waits for its turn in a
     * replay (`_crmHoldSave`): a lead's save other than an urgent one, whatever the
     * replay state when it is made. Otherwise the framework's update and save run
     * unchanged.
     *
     * @returns {boolean}
     */
    _crmMayHoldSave() {
        return !this.model._urgentSave && this.resModel === "crm.lead";
    }

    /**
     * Run inside an action of the model's mutex, with the record's changes applied:
     * when the replay has still to send queued writes of a field of the lead the save
     * must follow (`crmLeadWriteTurn`), holds the save of those changes, given `args`,
     * until its turn without waiting here (`CrmKanbanModel.crmHoldWrite`, which marks
     * the record and tracks the hold), and returns the promise of its result: at its
     * turn the save runs in an action of the mutex of its own (`crmExecHeld`,
     * `_crmSaveAtTurn`). `undefined` when the save may run now, in the calling action:
     * an urgent save (a page closed since the save was asked), or nothing to wait for.
     *
     * @param {ArrayLike<any>} args the arguments of the save
     * @returns {Promise<boolean>|undefined}
     */
    _crmHoldSave(args) {
        if (this.model._urgentSave) {
            return undefined;
        }
        const fieldNames = Object.keys(this._changes);
        const model = this.model;
        const turn = crmLeadWriteTurn(model.offlinePlugin, [this], fieldNames, model.crmDestroyed);
        if (!turn) {
            return undefined;
        }
        toRaw(this)._crmSaveQueued = false;
        return model.crmHoldWrite(this, fieldNames, turn, (outcome) =>
            model.crmExecHeld({ isSave: true }, () => this._crmSaveAtTurn(outcome, args))
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
     * list keeps the snapshot it was built with. Once the groups are built, a record
     * showing a held card save of the group-by field is placed in the group of the
     * value it shows (`CrmKanbanModel._crmPlaceHeldSaves`).
     */
    _setData(data) {
        if (this.config.isRoot && isCurrentRoot(this)) {
            this._crmServerValues = new Map();
        }
        super._setData(...arguments);
        this.model._crmPlaceHeldSaves(this);
    }

    /**
     * @override
     *
     * Builds the group, and with it the group's list, bound to this list's
     * server-value snapshot, so that the lists of a root all record into that
     * root's map. The group is built without the leads a held card delete hides,
     * counting them out (`CrmKanbanModel._crmWithoutHeldDeletes`); their server
     * stage and revenue are still recorded into the snapshot (`recordCrmServerValues`),
     * which the group's aggregates include, as for a card removed by a delete.
     */
    _createGroupDatapoint(data) {
        return this.model._crmBuildWith(this._crmServerValues, () => {
            const shown = this.model._crmWithoutHeldDeletes(data);
            if (shown !== data) {
                recordCrmServerValues(this, data.records);
            }
            return super._createGroupDatapoint(shown);
        });
    }

    /**
     * @override
     *
     * The kanban card menu deletes through the root (`model.root.deleteRecords`),
     * which is this list when grouped. During a replay that has still to send queued
     * calls of the deleted leads, the delete waits for its turn outside the model's
     * mutex (`deleteInTurn`): the confirmation ends and the cards are removed at once,
     * and the pipeline's other writes and loads go on meanwhile. Every other delete is
     * the framework's, unchanged.
     *
     * @param {Object[]} [records]
     * @returns {Promise<boolean>}
     */
    deleteRecords(records = []) {
        const held = deleteInTurn(this, records, (targets) => super._deleteRecords(targets));
        return held || super.deleteRecords(...arguments);
    }

    /**
     * @override
     *
     * Offline, the deleted cards are removed from their groups at once, each group
     * decrementing its own count. Online, during a replay that has still to send
     * queued calls of the deleted leads, a delete that reaches it (one `deleteRecords`
     * does not hold: of the whole domain, or a replay started between its call and its
     * run in the mutex) is sent after them (`deleteTurn`), with the user who made it
     * and the database of their session (`sendWithOrigin`), or queued after them when
     * its turn ends "queue only" (`deleteQueued`), and the cards are then removed at
     * once as well. A queued `unlink` (offline, its request lost, or queue only) is
     * stamped as it is queued after every queued call, pending or parked, of each lead
     * it deletes, the latest of all of them for several leads (the CRM
     * `OfflinePlugin.scheduleORM`): the replay sends those calls first, even when they
     * are stamped ahead of the clock.
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
        /** Set once built: its data set again later is a reload (`_setData`). */
        this._crmSetUp = true;
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
     *
     * The records are built without the leads a held card delete hides, its count
     * lowered as many (`CrmKanbanModel._crmWithoutHeldDeletes`), and show the values of
     * the held card saves of their leads (`_crmShowHeldSaves`): the server data was
     * read before those writes were sent. A group's list loaded again (a "Load more",
     * the reload of the group a card move left) then keeps in place the leads a held
     * save moves between groups (`_crmKeepHeldPlaces`).
     */
    _setData(data) {
        this._crmBeforeCommit?.();
        if (this.config.isRoot && isCurrentRoot(this)) {
            this._crmServerValues = new Map();
        }
        const previous = this._crmSetUp && !this.config.isRoot ? [...this.records] : null;
        recordCrmServerValues(this, data.records);
        super._setData(this.model._crmWithoutHeldDeletes(data));
        this.model._crmShowHeldSaves(this);
        if (previous) {
            this.model._crmKeepHeldPlaces(this, previous);
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
     * A delete through this list as the ungrouped root (`model.root.deleteRecords`)
     * made during a replay that has still to send queued calls of the deleted leads
     * waits for its turn outside the model's mutex (`deleteInTurn`): the confirmation
     * ends and the records are removed at once, and the view's other writes and loads
     * go on meanwhile. Every other delete is the framework's, unchanged.
     *
     * @param {Object[]} [records]
     * @returns {Promise<boolean>}
     */
    deleteRecords(records = []) {
        const held = deleteInTurn(this, records, (targets) => super._deleteRecords(targets));
        return held || super.deleteRecords(...arguments);
    }

    /**
     * @override
     *
     * Offline, the deleted records are removed from the list at once (ungrouped
     * root, or a group's list through `Group.deleteRecords`, the group then
     * decrementing its own count). Online, `super` reloads the model; during a
     * replay that has still to send queued calls of the deleted leads, a delete that
     * reaches it (one `deleteRecords` does not hold: through a group, of the whole
     * domain, or a replay started between its call and its run in the mutex) is sent
     * after them (`deleteTurn`), with the user who made it and the database of their
     * session (`sendWithOrigin`), or queued after them when its turn ends "queue
     * only" (`deleteQueued`), and the records are then removed at once as well.
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
