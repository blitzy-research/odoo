import { onWillDestroy, signal, toRaw, untrack } from "@odoo/owl";
import {
    crmContextWithOrigin,
    crmKeepOfflineUI,
    crmLeadWriteTurn,
    crmPendingLeadWrites,
    crmReplayQueued,
} from "@crm/mobile/crm_offline_hooks";
import { browser } from "@web/core/browser/browser";
import { registry } from "@web/core/registry";
import { unique } from "@web/core/utils/arrays";
import { listView } from "@web/views/list/list_view";
import { LeadGenerationDropdown } from "../../components/lead_generation_dropdown/lead_generation_dropdown";

/**
 * Queues the save of the lead list record `record` as the framework queues a save
 * whose request is lost (`_offlineSave`: `web_save` of `[[resId], changes]` with the
 * record's context and an empty specification), as an entry of its own holding the
 * changes of this save only, stamped after every pending (not parked) queued write
 * of the lead (`crmPendingLeadWrites`): the replay sends those writes first, and the
 * list's values last. An earlier queued save of the record stays as it is, in its
 * place. When nothing can be queued (a non-secure origin has no queue), the record
 * keeps its queued save and the error is thrown.
 *
 * The save commits the record's values, as an offline save does (`keepCommittedText`).
 *
 * @param {Object} record a `crm.lead` list record with an id
 */
function queueListSave(record) {
    const plugin = record.model.offlinePlugin;
    const writes = untrack(() =>
        crmPendingLeadWrites(plugin, record, Object.keys(record._changes))
    );
    let timeStamp = Date.now();
    for (const { value } of writes) {
        timeStamp = Math.max(timeStamp, (value.extras?.timeStamp || 0) + 1);
    }
    const raw = toRaw(record);
    const { _offlineId, _offlineChanges, _offlineTimeStamp } = raw;
    raw._offlineId = undefined;
    raw._offlineChanges = undefined;
    raw._offlineTimeStamp = timeStamp;
    try {
        record._offlineSave();
    } catch (error) {
        Object.assign(raw, { _offlineId, _offlineChanges, _offlineTimeStamp });
        throw error;
    }
    keepCommittedText(record);
}

/**
 * Takes the text values of the list record `record`, whose values a queued save just
 * committed, as its initial ones, as a save does (`_setData`). The framework ends a
 * multi-save that sent no request as a failed one, discarding the selected records
 * (`_discard`): their committed values stay, and the text values the evaluation
 * context reads then stay with them instead of returning to the loaded ones.
 *
 * @param {Object} record
 */
function keepCommittedText(record) {
    const raw = toRaw(record);
    raw._initialTextValues = { ...raw._textValues };
}

/**
 * Runs `multiSave`, the framework save of a lead list's selection
 * (`DynamicList._multiSave`), so that the leads it writes reach the server after
 * the pending queued writes of those leads, whose replay would otherwise overwrite
 * the values the user saved last.
 *
 * The model's ORM is replaced until the save settles. Its wrapper decides when the
 * multi-save's own `crm.lead` `webSave` or `webSaveMulti` is called, once the
 * framework has applied the changes to the selected records, checked them and asked
 * for its confirmation, so that the rows show the values while the save waits:
 * - While the replay has still to send queued writes of those leads, the save waits
 *   for its turn (`crmLeadWriteTurn`), holding the model mutex as any save does. At
 *   its turn, it is sent with the user who made it and the database of their session
 *   in its context (`crmContextWithOrigin`), which the server checks against the
 *   session the request reaches. Once the wait ends, or the held save settles, while
 *   the connection is reported lost, the buttons the list's Save disabled get the
 *   framework's offline UI when it re-enables them (`crmKeepOfflineUI`).
 * - While the connection is reported lost and one of those leads has a pending
 *   queued write (`crmPendingLeadWrites`), and when the turn ended "queue only" (the
 *   connection reported lost, or the view destroyed, during the wait) with such a
 *   write still pending, no request is sent: each written record is queued after its
 *   lead's writes (`queueListSave`), the save ends without error once the current
 *   task has run, and the replay is asked to deliver them (`crmReplayQueued`). A
 *   record listed twice (a lead in several groups) is queued once, the other rows
 *   commit the values locally.
 * - Otherwise the call is the framework's, sent at once and unchanged: with no
 *   replay running and nothing pending, the save is sent as before, with no added
 *   wait or request.
 *
 * Saves of other models and urgent saves (page close) are the framework's, and every
 * other call of the model's ORM is forwarded unchanged.
 *
 * @param {Object} list the root list of a lead list (`DynamicList`)
 * @param {() => Promise<boolean|undefined>} multiSave the parent's multi-save
 * @returns {Promise<boolean|undefined>} its result; `true` once the save is queued
 */
async function multiSaveInTurn(list, multiSave) {
    const model = toRaw(list.model);
    if (list.resModel !== "crm.lead" || model._urgentSave) {
        return multiSave();
    }
    const plugin = model.offlinePlugin;
    const orm = model.orm;
    // Rejection of the multi-save's call once its records are queued instead of sent.
    const queuedSave = Object.freeze({ crmListSaveQueued: true });
    // Set once the multi-save's own call is handled, or the save has ended: every
    // later call is forwarded unchanged.
    let settled = false;
    let queued = false;
    // Set once the multi-save's own call waits for its turn.
    let held = false;

    /**
     * @param {"webSave"|"webSaveMulti"} method
     * @param {IArguments} args the call's arguments: model, ids, values, kwargs
     * @returns {Promise<Object[]>} the saved records' values, as the ORM answers
     */
    function saveInTurn(method, args) {
        const [resModel, resIds, data, kwargs] = args;
        if (settled || resModel !== "crm.lead" || !resIds?.length || model._urgentSave) {
            return orm[method](...args);
        }
        settled = true;
        const records = list.selection.filter((record) => resIds.includes(record.resId));
        const fieldNames =
            method === "webSaveMulti" ? unique(data.flatMap(Object.keys)) : Object.keys(data);
        const queues = () =>
            untrack(() =>
                records.some(
                    (record) => crmPendingLeadWrites(plugin, record, fieldNames).length > 0
                )
            );
        const queue = () => {
            const leads = new Set();
            for (const record of records) {
                if (leads.has(record.resId)) {
                    record._commitSave();
                    keepCommittedText(record);
                } else {
                    queueListSave(record);
                    leads.add(record.resId);
                    queued = true;
                }
            }
            // Ends after the current task, as a sent save does: the key that committed
            // the values (Enter in a cell) then reaches the list while the row is still
            // in edition and leaves it, instead of finding the row saved and editing it
            // again.
            return new Promise((resolve, reject) => browser.setTimeout(() => reject(queuedSave)));
        };
        const turn = crmLeadWriteTurn(plugin, records, fieldNames, model.crmDestroyed);
        if (!turn) {
            return untrack(() => plugin.isOffline()) && queues() ? queue() : orm[method](...args);
        }
        held = true;
        return turn.then(({ queueOnly, origin }) => {
            if ((queueOnly || untrack(() => plugin.isOffline())) && queues()) {
                return queue();
            }
            const context = crmContextWithOrigin(kwargs?.context, origin);
            return orm[method](resModel, resIds, data, { ...kwargs, context });
        });
    }

    const turnOrm = Object.assign(Object.create(orm), {
        webSave() {
            return saveInTurn("webSave", arguments);
        },
        webSaveMulti() {
            return saveInTurn("webSaveMulti", arguments);
        },
    });
    model.orm = turnOrm;
    try {
        return await multiSave();
    } catch (error) {
        if (error === queuedSave) {
            return true;
        }
        throw error;
    } finally {
        settled = true;
        if (model.orm === turnOrm) {
            model.orm = orm;
        }
        if (queued) {
            crmReplayQueued(plugin);
        }
        // A held save that settles while the connection is reported lost (its request
        // lost) leaves the buttons its caller (the list's Save) disabled to the offline
        // UI.
        if (held) {
            crmKeepOfflineUI(plugin);
        }
    }
}

export class CrmListDynamicRecordList extends listView.Model.DynamicRecordList {
    /**
     * @override
     * The save of the selected leads is sent in its turn in the replay, or queued
     * after their pending writes (`multiSaveInTurn`).
     */
    _multiSave() {
        return multiSaveInTurn(this, () => super._multiSave(...arguments));
    }
}

export class CrmListDynamicGroupList extends listView.Model.DynamicGroupList {
    /**
     * @override
     * The save of the selected leads of a grouped list is sent in its turn in the
     * replay, or queued after their pending writes (`multiSaveInTurn`).
     */
    _multiSave() {
        return multiSaveInTurn(this, () => super._multiSave(...arguments));
    }
}

/**
 * Lead list model, also used, through `ForecastListModel`, by the forecast list.
 *
 * A save of selected leads (a multi-edit of the list) made while the replay has
 * still to send queued writes of those leads waits for them, and one made while the
 * connection is reported lost with such a write pending is queued after it, so that
 * the values the user saved last are the ones the server keeps (`multiSaveInTurn`).
 */
export class CrmListModel extends listView.Model {
    setup() {
        super.setup(...arguments);
        // Assigned here rather than as a class field: `Model`'s constructor runs
        // `setup` before any class field of this class would be initialised.
        /** Set once the view owning the model is destroyed (`multiSaveInTurn`). */
        this.crmDestroyed = signal(false);
        onWillDestroy(() => this.crmDestroyed.set(true));
    }
}
CrmListModel.DynamicRecordList = CrmListDynamicRecordList;
CrmListModel.DynamicGroupList = CrmListDynamicGroupList;

export const crmListView = {
    ...listView,
    Model: CrmListModel,
    Controller: class extends listView.Controller {
        static components = {
            ...listView.Controller.components,
            LeadGenerationDropdown,
        }
    },
    buttonTemplate: "crm.List.Buttons",
};

registry.category("views").add("crm_list", crmListView);
