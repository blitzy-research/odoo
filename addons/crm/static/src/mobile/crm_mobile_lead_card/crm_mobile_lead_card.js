import {
    Component,
    computed,
    onMounted,
    onWillStart,
    proxy,
    signal,
    status,
    toRaw,
    untrack,
    useEffect,
} from "@odoo/owl";
import { deserializeDate, formatDate, serializeDate } from "@web/core/l10n/dates";
import { _t } from "@web/core/l10n/translation";
import { usePopover } from "@web/core/popover/popover_hook";
import { user } from "@web/core/user";
import { uniqueId } from "@web/core/utils/functions";
import { useBus } from "@web/core/utils/hooks";
import { formatMonetary } from "@web/views/fields/formatters";
import { useCrmOffline } from "@crm/mobile/crm_offline_hooks";

const { DateTime } = luxon;

/**
 * Label of a relational value shown in the activity sheet. Loaded records give a
 * many2one as `{id, display_name}`; queued activities give a bare id, resolved
 * against the options read from the relational-field cache.
 *
 * @param {{display_name?: string}|number|false|undefined} value
 * @param {{id: number, display_name: string}[]} options
 * @returns {string} never `undefined`, so no "undefined" text is rendered
 */
function relationLabel(value, options) {
    if (value && typeof value === "object") {
        return value.display_name || "";
    }
    return options.find((option) => option.id === value)?.display_name || "";
}

/**
 * Id of one of `options` held by a schedule-form value: the number the form opens
 * with, or the digits string a `<select>` change gives.
 *
 * @param {number|string|null|undefined} value
 * @param {{id: number}[]} options
 * @returns {number|false} `false` unless `value` is the id of one of `options`
 */
function optionId(value, options) {
    const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    return Number.isInteger(id) && options.some((option) => option.id === id) ? id : false;
}

/**
 * The server holds a date as a Python `date`, whose years run from 0001 to 9999:
 * the four-digit pattern caps the year at 9999, and year 0, which Luxon accepts,
 * is rejected here, so no deadline the server would refuse is sent or queued.
 *
 * @param {unknown} value value of the schedule form's `<input type="date">`
 * @returns {string|false} `value` when it is an existing date in the server format
 *  ("YYYY-MM-DD") from 0001-01-01 to 9999-12-31, else `false`
 */
function serverDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }
    const date = deserializeDate(value);
    return date.isValid && date.year >= 1 ? value : false;
}

/**
 * Activity bottom sheet of a lead, opened from the mobile lead card and, on a
 * phone, from the lead form's "Activities" button.
 *
 * It lists the lead's synced activities (from the activity rows loaded with the
 * opener's own root load) and the activities queued offline (from the framework
 * queue), and offers "Log a call", "Schedule follow-up" and "Mark done". Every
 * write goes through `useCrmOffline()`: online it reaches the server and reloads
 * the lead record, offline it is queued and its row appears at once, projected
 * from the queue. No meeting or calendar action is offered. The opener's mobile
 * root load reads a bounded page of activity rows per lead: online, "Show more"
 * has the opener reload its root with the next page.
 *
 * The bottom-sheet service keeps the props it was opened with, while a reload
 * replaces the opener's records, so the sheet never stores a record: every render
 * reads `getLeadRecord()`. `refresh()` re-renders it on the opener model's
 * `update` event, after a replay and after a systray discard, and closes it when
 * the lead is gone (deleted, archived, filtered out, or the form moved on); the
 * same check runs on mount, for a lead gone while the sheet was starting, and
 * whenever the opener's records change, since a root reload emits no event. The
 * activity types and assignees are read from the relational-field cache at
 * startup, and again when types reach that cache while the sheet is open.
 *
 * @example
 * this.activitiesSheet = usePopover(CrmMobileLeadActivities, { useBottomSheet: true });
 * const leadId = record.resId;
 * this.activitiesSheet.open(target, {
 *     leadId,
 *     getLeadRecord: () => this.props.getRecord(leadId),
 *     model: record.model,
 *     callTypeId: this.crmOffline.callTypeId(archInfo),
 * });
 */
export class CrmMobileLeadActivities extends Component {
    static template = "crm.CrmMobileLeadActivities";
    static props = {
        leadId: Number,
        getLeadRecord: Function,
        model: Object,
        callTypeId: { type: [Number, Boolean], optional: true },
        close: { type: Function, optional: true },
    };

    /**
     * Type, date and assignee controls of the schedule form (`t-ref`), in display
     * order: Save focuses the first one it finds invalid.
     */
    typeRef = signal(null);
    dateRef = signal(null);
    userRef = signal(null);

    /**
     * Unique per sheet, so the invalid-field messages referenced by
     * `aria-describedby` never share an id with another sheet's.
     */
    fieldIdPrefix = uniqueId("o_crm_mobile_activity_form_");

    setup() {
        this.crmOffline = useCrmOffline();
        this.state = proxy({
            // Bumped by `refresh()` and after each write; every getter reading the
            // lead record reads it first, so the render subscribes to it.
            version: 0,
            types: [],
            assignees: [],
            // Values of the inline schedule form, or `null` when it is closed.
            form: null,
            // Validity flags of the form fields, by field name: `true` from a Save
            // that found the field invalid until the field changes or a form opens.
            invalid: {},
            saving: false,
            // Activity ids whose "mark done" request is running (transient, unlike
            // the queue-derived pending state): `{[activityId]: true}`.
            doneBusy: {},
            // Activity ids this sheet marked done on the server (online, not
            // queued): `{[activityId]: true}`. Their rows leave the list at once, as
            // the lead's reload shows them, even when that reload fails.
            doneOnline: {},
            // A "Show more" reload of the opener's root is running.
            loadingMore: false,
        });
        // The template reads the activity data and the synced rows several times
        // per render: each is computed once, and again only after something it
        // read changes (the lead record through `state.version`, the queue, the
        // cached options, `state.doneBusy`, `state.doneOnline`).
        this.activityDataMemo = computed(() => this.computeActivityData());
        this.syncedRowsMemo = computed(() => this.computeSyncedRows());
        /** Set once `closeIfLeadGone()` has closed the sheet. */
        this.closed = false;
        /** Numbers of the last options read started and of the last one applied. */
        this.optionsReads = 0;
        this.optionsApplied = 0;
        /** Lead record the running "Show more" reload started from. */
        this.loadingMoreFrom = null;
        const refresh = () => this.refresh();
        useBus(this.props.model.bus, "update", refresh);
        this.crmOffline.onReplayed(refresh);
        this.crmOffline.onEntriesDiscarded("mail.activity", refresh);
        this.crmOffline.onEntriesDiscarded("crm.lead", refresh);
        onWillStart(() => this.loadOptions());
        // The lead may be gone before the sheet is mounted (the form moved to another
        // record while the startup reads ran): it is checked again once mounted.
        onMounted(() => this.closeIfLeadGone());
        // Once mounted, the sheet follows its lead reactively: the opener's models
        // replace their records without a bus event (a form pager move reloads the
        // root silently), so it closes as soon as `getLeadRecord()` returns nothing.
        useEffect(() => {
            const leadGone = !this.props.getLeadRecord();
            if (leadGone && status(this) === "mounted") {
                untrack(() => this.closeIfLeadGone());
            }
        });
        // Types cached after the startup read (a warm-up finishing while the sheet
        // is open, or run by the opener when the connection returns) are read again,
        // so "Log a call" and "Schedule follow-up" enable without reopening. The
        // first run, during setup, only records the state: `onWillStart` reads.
        let seenRevision = null;
        let wasOffline = false;
        useEffect(() => {
            const revision = this.crmOffline.activityTypesRevision();
            const offline = this.crmOffline.isOffline();
            const reread =
                seenRevision !== null && (revision !== seenRevision || (wasOffline && !offline));
            seenRevision = revision;
            wasOffline = offline;
            if (reread) {
                untrack(() => this.reloadOptions());
            }
        });
    }

    /**
     * Re-renders with the opener's current lead record, and closes the sheet when
     * there is none any more.
     */
    refresh() {
        this.state.version++;
        this.closeIfLeadGone();
    }

    /**
     * Closes the sheet when the opener no longer has its lead (deleted, archived,
     * filtered out, or the form moved on). It closes once: each bottom-sheet close
     * also decrements the service's count of open sheets.
     */
    closeIfLeadGone() {
        if (this.closed || this.props.getLeadRecord()) {
            return;
        }
        this.closed = true;
        this.props.close?.();
    }

    /**
     * Reads the activity types and the assignees from the relational-field cache
     * (no RPC, online or offline). Reads may overlap: one is applied only when no
     * later-started read was applied before it, and none once the sheet is
     * destroyed.
     */
    async loadOptions() {
        const read = ++this.optionsReads;
        const [types, assignees] = await Promise.all([
            this.crmOffline.getActivityTypes(),
            this.crmOffline.getAssignees(),
        ]);
        if (read < this.optionsApplied || status(this) === "destroyed") {
            return;
        }
        this.optionsApplied = read;
        this.state.types = types;
        this.state.assignees = assignees;
    }

    /** Reads the options again, after the startup read. */
    async reloadOptions() {
        try {
            await this.loadOptions();
        } catch {
            // A cache-only refresh of options already read at startup: when the
            // cache cannot be read, the sheet keeps the options it shows.
        }
    }

    /** @returns {Object|null|undefined} the lead record currently loaded by the opener */
    get leadRecord() {
        void this.state.version;
        return this.props.getLeadRecord();
    }

    /**
     * Activity rows of the lead record currently loaded by the opener, from
     * `useCrmOffline().activityRows()`. Run by `activityDataMemo` only.
     *
     * @returns {{rows: Object[], moreCount: number, variant: string}|null} `null`
     *  without a record, or when the record carries no activity data
     */
    computeActivityData() {
        const record = this.leadRecord;
        return record ? this.crmOffline.activityRows(record) : null;
    }

    /**
     * @returns {{rows: Object[], moreCount: number, variant: string}|null} the
     *  activity data of the current render (see `computeActivityData`)
     */
    get activityData() {
        return this.activityDataMemo();
    }

    /**
     * Synced activities, each with its labels, its queued "mark done" state
     * (`donePending`) and whether its "mark done" request is running
     * (`doneBusy`). The queue is read once for all rows: one set of the activity
     * ids a queued `action_done` targets, matched as `isActivityDonePending()`
     * does. Activities this sheet marked done online (`state.doneOnline`) are
     * left out. Run by `syncedRowsMemo` only.
     *
     * @returns {Object[]}
     */
    computeSyncedRows() {
        const rows = (this.activityData?.rows || []).filter(
            (row) => !this.state.doneOnline[row.id]
        );
        const donePendingIds = new Set();
        for (const { value } of this.crmOffline.queuedEntries("mail.activity")) {
            const ids = value.args?.[0];
            if (value.method === "action_done" && Array.isArray(ids)) {
                for (const id of ids) {
                    donePendingIds.add(id);
                }
            }
        }
        return rows.map((row) => ({
            ...row,
            donePending: Boolean(row.id) && donePendingIds.has(row.id),
            doneBusy: Boolean(this.state.doneBusy[row.id]),
            typeLabel: this.typeLabel(row.activity_type_id),
            deadlineLabel: this.deadlineLabel(row.date_deadline),
            assigneeLabel: this.assigneeLabel(row.user_id),
        }));
    }

    /** @returns {Object[]} the synced rows of the current render (see `computeSyncedRows`) */
    get syncedRows() {
        return this.syncedRowsMemo();
    }

    /**
     * Activities queued offline on this lead. They come from the queue, not from
     * the record, so parked ones survive every reload.
     */
    get pendingRows() {
        void this.state.version;
        return this.crmOffline.pendingActivities(this.props.leadId).map((row) => ({
            ...row,
            typeLabel: this.typeLabel(row.activity_type_id),
            deadlineLabel: this.deadlineLabel(row.date_deadline),
        }));
    }

    /** Activities beyond the next one when only the desktop variant is cached. */
    get moreCount() {
        return this.activityData?.moreCount || 0;
    }

    /**
     * True when the lead carries no activity data at all (seen online only in a
     * wide-layout form): the sheet then explains that activities load after sync,
     * and scheduling stays available.
     */
    get hasNoActivityData() {
        return this.activityData === null;
    }

    get hasTypes() {
        return this.state.types.length > 0;
    }

    /** "Log a call" needs the arch's Call type among the cached types. */
    get canLogCall() {
        const { callTypeId } = this.props;
        return (
            this.hasTypes &&
            Boolean(callTypeId) &&
            this.state.types.some((type) => type.id === callTypeId)
        );
    }

    /**
     * "Show more" is offered online when the opener's bounded mobile root load
     * left some of the lead's activities out and the opener can reload its root
     * with one more page (`crmLoadMoreActivities` model hook). Offline, the larger
     * page was never cached: the remaining activities wait for sync.
     */
    get canLoadMoreActivities() {
        const activityData = this.activityData;
        return (
            activityData?.variant === "mobile" &&
            activityData.moreCount > 0 &&
            !this.crmOffline.isOffline() &&
            typeof this.props.model.hooks?.crmLoadMoreActivities === "function"
        );
    }

    /**
     * A "Show more" reload started from the displayed lead record is running. A
     * reload superseded by another root load never settles, while that other load
     * replaces the record: "Show more" is then available again.
     */
    get isLoadingMoreActivities() {
        return this.state.loadingMore && toRaw(this.loadingMoreFrom) === toRaw(this.leadRecord);
    }

    /** @param {{display_name?: string}|number|false} value */
    typeLabel(value) {
        return relationLabel(value, this.state.types);
    }

    /** @param {{display_name?: string}|number|false} value */
    assigneeLabel(value) {
        return relationLabel(value, this.state.assignees);
    }

    /**
     * @param {import("luxon").DateTime|string|false} value a loaded date, or the
     *  "YYYY-MM-DD" string of a queued activity
     * @returns {string}
     */
    deadlineLabel(value) {
        if (!value) {
            return "";
        }
        return formatDate(value.isLuxonDateTime ? value : deserializeDate(value));
    }

    /**
     * @param {string} name a form field name, or `<field>_feedback` for its message
     * @returns {string} DOM id of that element, unique to this sheet
     */
    fieldId(name) {
        return `${this.fieldIdPrefix}_${name}`;
    }

    /**
     * Opens the form on the arch's Call type (`mail.mail_activity_data_call`),
     * selected by id: To-Do precedes Call in sequence, so position is meaningless.
     * The new form starts with no field flagged invalid.
     */
    openLogCall() {
        if (!this.canLogCall) {
            return;
        }
        this.state.invalid = {};
        this.state.form = {
            activity_type_id: this.props.callTypeId,
            summary: _t("Call"),
            date_deadline: serializeDate(DateTime.local()),
            user_id: user.userId,
        };
    }

    /**
     * Opens the form on the first cached type, due tomorrow, with no field
     * flagged invalid.
     */
    openFollowUp() {
        if (!this.hasTypes) {
            return;
        }
        this.state.invalid = {};
        this.state.form = {
            activity_type_id: this.state.types[0].id,
            summary: "",
            date_deadline: serializeDate(DateTime.local().plus({ days: 1 })),
            user_id: user.userId,
        };
    }

    /**
     * Stores a form field's new value. A field flagged invalid by Save is no
     * longer flagged once it changes; the next Save checks it again.
     *
     * @param {"activity_type_id"|"summary"|"date_deadline"|"user_id"} fieldName
     * @param {Event} ev
     */
    onFormChange(fieldName, ev) {
        this.state.form[fieldName] = ev.target.value;
        if (this.state.invalid[fieldName]) {
            this.state.invalid[fieldName] = false;
        }
    }

    /**
     * Closes the schedule form without scheduling, clearing its invalid-field
     * flags. Ignored while Save runs (its button is disabled then too), so the
     * form being saved is never swapped for another one whose draft the save
     * would then discard.
     */
    cancelForm() {
        if (this.state.saving) {
            return;
        }
        this.state.invalid = {};
        this.state.form = null;
    }

    /**
     * Values to schedule from the form, checked against what the form offers:
     * the type and the assignee must be ids of the cached options and the
     * deadline an existing "YYYY-MM-DD" date; the summary is sent as a string.
     * When a check fails, the failing fields are flagged invalid (each with its
     * message), the first of them is focused, and nothing is returned; the form
     * keeps every value.
     *
     * @param {{activity_type_id: unknown, summary: unknown, date_deadline: unknown, user_id: unknown}} form
     * @returns {{activity_type_id: number, summary: string, date_deadline: string, user_id: number}|null}
     */
    validateForm(form) {
        const vals = {
            activity_type_id: optionId(form.activity_type_id, this.state.types),
            summary: String(form.summary ?? ""),
            date_deadline: serverDate(form.date_deadline),
            user_id: optionId(form.user_id, this.state.assignees),
        };
        const checkedFields = [
            ["activity_type_id", this.typeRef],
            ["date_deadline", this.dateRef],
            ["user_id", this.userRef],
        ];
        this.state.invalid = Object.fromEntries(
            checkedFields.map(([fieldName]) => [fieldName, !vals[fieldName]])
        );
        const firstInvalid = checkedFields.find(([fieldName]) => !vals[fieldName]);
        if (!firstInvalid) {
            return vals;
        }
        firstInvalid[1]()?.focus();
        return null;
    }

    /**
     * Schedules the activity on the lead currently loaded by the opener. Offline
     * the queued row appears through the queue signal. Online the hooks reload
     * the lead record, so no reload happens here. Invalid values (see
     * `validateForm`) schedule nothing and keep the form open with the failing
     * fields flagged. A server error keeps the form open with its values and
     * reaches the framework error handling. When the opener no longer has the
     * lead, nothing is scheduled and the sheet closes through `closeIfLeadGone()`,
     * so a Save reaching a sheet already closed for its lead closes nothing more.
     */
    async saveForm() {
        const { form } = this.state;
        if (this.state.saving || !form) {
            return;
        }
        const record = this.leadRecord;
        if (!record) {
            this.closeIfLeadGone();
            return;
        }
        const vals = this.validateForm(form);
        if (!vals) {
            return;
        }
        this.state.saving = true;
        try {
            await this.crmOffline.scheduleActivity(record, vals);
            // Close only the form that was submitted: a form opened since then
            // keeps its draft.
            if (toRaw(this.state.form) === toRaw(form)) {
                this.state.form = null;
            }
        } finally {
            this.state.saving = false;
            this.state.version++;
        }
    }

    /**
     * Marks a synced activity done (queued offline; online the hooks reload the
     * lead record). It is sent at most once: nothing happens while a request for
     * the same activity runs (`state.doneBusy`, set before the first await), once
     * it is done on the server (`state.doneOnline`: its row leaves the list then,
     * even when the lead reload that follows fails or is lost) or once its "mark
     * done" waits in the queue, read live rather than from the row, which may come
     * from an earlier render.
     *
     * @param {{id: number}} row
     */
    async markDone(row) {
        const record = this.leadRecord;
        const { id } = row;
        if (
            !record ||
            this.state.doneBusy[id] ||
            this.state.doneOnline[id] ||
            this.crmOffline.isActivityDonePending(id)
        ) {
            return;
        }
        this.state.doneBusy[id] = true;
        try {
            await this.crmOffline.markActivityDone(record, id);
            // Not queued (the call is queued offline, or when the connection drops
            // during it): the server has done it.
            if (!this.crmOffline.isActivityDonePending(id)) {
                this.state.doneOnline[id] = true;
            }
            this.state.version++;
        } finally {
            delete this.state.doneBusy[id];
        }
    }

    /**
     * "Show more": the opener reloads its root with one more page of activity
     * rows (never a separate `mail.activity` read). The sheet then reads the
     * reloaded lead record, as after any other reload, and stays open.
     */
    async loadMoreActivities() {
        if (!this.canLoadMoreActivities || this.isLoadingMoreActivities) {
            return;
        }
        const record = this.leadRecord;
        this.loadingMoreFrom = record;
        this.state.loadingMore = true;
        try {
            await this.props.model.hooks.crmLoadMoreActivities(this.props.leadId);
        } finally {
            if (this.loadingMoreFrom === record) {
                this.loadingMoreFrom = null;
                this.state.loadingMore = false;
            }
            this.state.version++;
        }
    }
}

/**
 * Lead card of the mobile pipeline.
 *
 * It shows the lead's name, partner (or contact name) and expected revenue with
 * the writes queued for it applied, so offline edits made anywhere are visible,
 * and a "Pending sync" badge ("Sync failed" once parked) read from the framework
 * queue alone. It offers opening the lead, a stage selector and the activity
 * sheet. A provisional card (a lead created offline, `provisional` set and no
 * `record`) can do none of these until its create is replayed.
 *
 * The pipeline renders it only on its small-screen branch; the card holds no
 * screen-size logic of its own.
 */
export class CrmMobileLeadCard extends Component {
    static template = "crm.CrmMobileLeadCard";
    static components = {};
    static props = {
        record: { type: Object, optional: true },
        provisional: { type: Object, optional: true },
        stages: Array,
        archInfo: Object,
        getRecord: Function,
        onOpen: Function,
        onMoveStage: Function,
    };

    setup() {
        this.crmOffline = useCrmOffline();
        // usePopover closes the sheet when this card unmounts. The sheet stays
        // open across a reload only because the pipeline keys its cards by
        // `record.resId`, so the reloaded card is the same component.
        this.activitiesSheet = usePopover(CrmMobileLeadActivities, { useBottomSheet: true });
    }

    get isProvisional() {
        return Boolean(this.props.provisional);
    }

    /**
     * Display values `{name, partner_id, contact_name, expected_revenue,
     * stage_id}`: the provisional values, else the record projected with its
     * queued writes. `null` while a queued delete or archive hides the card, and
     * for a card given neither `record` nor `provisional`, which renders nothing.
     *
     * @returns {Object|null}
     */
    get values() {
        if (this.isProvisional) {
            return this.props.provisional;
        }
        if (!this.props.record) {
            return null;
        }
        return this.crmOffline.projectLead(this.props.record);
    }

    /**
     * Everything the template shows, computed once per render: one projection of
     * the lead and one sync-state read for its badge and status region, whatever
     * the number of stage options. `null` when the card renders nothing (see
     * `values`).
     *
     * @returns {{values: Object, partnerLabel: string, revenueLabel: string,
     *  stage: {id: number|false, missing: boolean, label: string}|null,
     *  syncState: "failed"|"pending"|false}|null}
     */
    get cardData() {
        const values = this.values;
        if (!values) {
            return null;
        }
        return {
            values,
            partnerLabel: this.partnerLabel(values),
            revenueLabel: this.revenueLabel(values),
            stage: this.stageChoice(values),
            syncState: this.syncState,
        };
    }

    /** @param {Object} values display values (see `values`) */
    partnerLabel(values) {
        const { partner_id, contact_name } = values;
        return partner_id?.display_name || contact_name || "";
    }

    /**
     * Empty when the revenue was not loaded (desktop-variant offline fallback).
     *
     * @param {Object} values display values (see `values`)
     */
    revenueLabel(values) {
        const revenue = values.expected_revenue;
        if (revenue === undefined) {
            return "";
        }
        return formatMonetary(revenue, {
            currencyId: this.props.record?.data.company_currency?.id,
        });
    }

    /**
     * Stage id from a many2one value or a bare id (provisional cards).
     *
     * @param {Object} values display values (see `values`)
     * @returns {number|false}
     */
    selectedStageId(values) {
        const { stage_id } = values;
        return stage_id?.id ?? stage_id ?? false;
    }

    /**
     * State of the stage selector, or `null` when the card shows none: the stage
     * was not loaded (desktop-variant offline fallback of an arch without it), or
     * there is no stage to choose. `missing` tells that the lead's stage is none of
     * the choices (no stage, or one the pipeline does not list): the selector then
     * shows `label` as its current, unselectable option, so that no real stage is
     * presented as current. A lead without stage reads "None", as its group does.
     *
     * @param {Object} values display values (see `values`)
     * @returns {{id: number|false, missing: boolean, label: string}|null}
     */
    stageChoice(values) {
        if (values.stage_id === undefined || !this.props.stages.length) {
            return null;
        }
        const id = this.selectedStageId(values);
        const missing = !this.props.stages.some((stage) => stage.id === id);
        let label = "";
        if (missing) {
            label = id ? values.stage_id.display_name || "" : _t("None");
        }
        return { id, missing, label };
    }

    /**
     * Sync state from the queue: `"failed"` when parked (checked first, as a
     * parked write also counts as pending), `"pending"` when queued, else `false`
     * (also without a record).
     */
    get syncState() {
        if (this.isProvisional) {
            return this.props.provisional.parked ? "failed" : "pending";
        }
        const { record } = this.props;
        if (!record) {
            return false;
        }
        if (this.crmOffline.hasParkedWrite(record)) {
            return "failed";
        }
        return this.crmOffline.hasPendingWrite(record) ? "pending" : false;
    }

    /** The pipeline opens the form, or the offline helper for an uncached lead. */
    onOpenClick() {
        if (this.isProvisional || !this.props.record) {
            return;
        }
        return this.props.onOpen(this.props.record);
    }

    /** @param {Event} ev change event of the stage `<select>` */
    onStageChange(ev) {
        if (this.isProvisional || !this.props.record) {
            return;
        }
        const values = this.values;
        const stageId = Number(ev.target.value);
        if (values && stageId && stageId !== this.selectedStageId(values)) {
            return this.props.onMoveStage(this.props.record, stageId);
        }
    }

    /**
     * Opens the activity sheet. Scheduling needs the lead's server id, so a
     * provisional card has no sheet.
     *
     * @param {MouseEvent} ev
     */
    openActivities(ev) {
        if (this.isProvisional || !this.props.record?.resId) {
            return;
        }
        const leadId = this.props.record.resId;
        this.activitiesSheet.open(ev.currentTarget, {
            leadId,
            getLeadRecord: () => this.props.getRecord(leadId),
            model: this.props.record.model,
            callTypeId: this.crmOffline.callTypeId(this.props.archInfo) || false,
        });
    }
}
