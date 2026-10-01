import { Component, onWillStart, proxy } from "@odoo/owl";
import { deserializeDate, formatDate, serializeDate } from "@web/core/l10n/dates";
import { _t } from "@web/core/l10n/translation";
import { usePopover } from "@web/core/popover/popover_hook";
import { user } from "@web/core/user";
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
 * Activity bottom sheet of a lead, opened from the mobile lead card and, on a
 * phone, from the lead form's "Activities" button.
 *
 * It lists the lead's synced activities (from the activity rows loaded with the
 * opener's own root load) and the activities queued offline (from the framework
 * queue), and offers "Log a call", "Schedule follow-up" and "Mark done". Every
 * write goes through `useCrmOffline()`: online it reaches the server and reloads
 * the lead record, offline it is queued and its row appears at once, projected
 * from the queue. No meeting or calendar action is offered.
 *
 * The bottom-sheet service keeps the props it was opened with, while a reload
 * replaces the opener's records, so the sheet never stores a record: every render
 * reads `getLeadRecord()`. `refresh()` re-renders it on the opener model's
 * `update` event, after a replay and after a systray discard, and closes it when
 * the lead is gone (deleted, archived, filtered out, or the form moved on).
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
            saving: false,
        });
        const refresh = () => this.refresh();
        useBus(this.props.model.bus, "update", refresh);
        this.crmOffline.onReplayed(refresh);
        this.crmOffline.onEntriesDiscarded("mail.activity", refresh);
        this.crmOffline.onEntriesDiscarded("crm.lead", refresh);
        onWillStart(async () => {
            // Both read the relational-field cache: no RPC, online or offline.
            const [types, assignees] = await Promise.all([
                this.crmOffline.getActivityTypes(),
                this.crmOffline.getAssignees(),
            ]);
            this.state.types = types;
            this.state.assignees = assignees;
        });
    }

    /**
     * Re-renders with the opener's current lead record, and closes the sheet when
     * there is none any more.
     */
    refresh() {
        this.state.version++;
        if (!this.props.getLeadRecord()) {
            this.props.close?.();
        }
    }

    /** @returns {Object|null|undefined} the lead record currently loaded by the opener */
    get leadRecord() {
        void this.state.version;
        return this.props.getLeadRecord();
    }

    /** @returns {{rows: Object[], moreCount: number, variant: string}|null} */
    get activityData() {
        const record = this.leadRecord;
        return record ? this.crmOffline.activityRows(record) : null;
    }

    /** Synced activities, each with its labels and its queued "mark done" state. */
    get syncedRows() {
        return (this.activityData?.rows || []).map((row) => ({
            ...row,
            donePending: this.crmOffline.isActivityDonePending(row.id),
            typeLabel: this.typeLabel(row.activity_type_id),
            deadlineLabel: this.deadlineLabel(row.date_deadline),
            assigneeLabel: this.assigneeLabel(row.user_id),
        }));
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
     * Opens the form on the arch's Call type (`mail.mail_activity_data_call`),
     * selected by id: To-Do precedes Call in sequence, so position is meaningless.
     */
    openLogCall() {
        if (!this.canLogCall) {
            return;
        }
        this.state.form = {
            activity_type_id: this.props.callTypeId,
            summary: _t("Call"),
            date_deadline: serializeDate(DateTime.local()),
            user_id: user.userId,
        };
    }

    /** Opens the form on the first cached type, due tomorrow. */
    openFollowUp() {
        if (!this.hasTypes) {
            return;
        }
        this.state.form = {
            activity_type_id: this.state.types[0].id,
            summary: "",
            date_deadline: serializeDate(DateTime.local().plus({ days: 1 })),
            user_id: user.userId,
        };
    }

    /**
     * @param {"activity_type_id"|"summary"|"date_deadline"|"user_id"} fieldName
     * @param {Event} ev
     */
    onFormChange(fieldName, ev) {
        this.state.form[fieldName] = ev.target.value;
    }

    cancelForm() {
        this.state.form = null;
    }

    /**
     * Schedules the activity on the lead currently loaded by the opener. Offline
     * the queued row appears through the queue signal. Online the hooks reload
     * the lead record, so no reload happens here. A server error keeps the form
     * open and reaches the framework error handling.
     */
    async saveForm() {
        const { form } = this.state;
        if (this.state.saving || !form?.activity_type_id || !form.date_deadline) {
            return;
        }
        const record = this.leadRecord;
        if (!record) {
            this.props.close?.();
            return;
        }
        const vals = {
            activity_type_id: Number(form.activity_type_id),
            summary: form.summary,
            date_deadline: form.date_deadline,
            user_id: Number(form.user_id),
        };
        this.state.saving = true;
        try {
            await this.crmOffline.scheduleActivity(record, vals);
            this.state.form = null;
        } finally {
            this.state.saving = false;
            this.state.version++;
        }
    }

    /**
     * Marks a synced activity done (queued offline; online the hooks reload the
     * lead record). A row whose "mark done" is already queued is left alone.
     *
     * @param {{id: number, donePending: boolean}} row
     */
    async markDone(row) {
        const record = this.leadRecord;
        if (row.donePending || !record) {
            return;
        }
        await this.crmOffline.markActivityDone(record, row.id);
        this.state.version++;
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
     * stage_id}`, or `null` while a queued delete or archive hides the card.
     */
    get values() {
        if (this.isProvisional) {
            return this.props.provisional;
        }
        return this.crmOffline.projectLead(this.props.record);
    }

    get partnerLabel() {
        const { partner_id, contact_name } = this.values;
        return partner_id?.display_name || contact_name || "";
    }

    /** Empty when the revenue was not loaded (desktop-variant offline fallback). */
    get revenueLabel() {
        const revenue = this.values.expected_revenue;
        if (revenue === undefined) {
            return "";
        }
        return formatMonetary(revenue, {
            currencyId: this.props.record?.data.company_currency?.id,
        });
    }

    /** Stage id from a many2one value or a bare id (provisional cards). */
    get selectedStageId() {
        const { stage_id } = this.values;
        return stage_id?.id ?? stage_id ?? false;
    }

    /**
     * Sync state from the queue: `"failed"` when parked (checked first, as a
     * parked write also counts as pending), `"pending"` when queued, else `false`.
     */
    get syncState() {
        if (this.isProvisional) {
            return this.props.provisional.parked ? "failed" : "pending";
        }
        const { record } = this.props;
        if (this.crmOffline.hasParkedWrite(record)) {
            return "failed";
        }
        return this.crmOffline.hasPendingWrite(record) ? "pending" : false;
    }

    /** The pipeline opens the form, or the offline helper for an uncached lead. */
    onOpenClick() {
        if (this.isProvisional) {
            return;
        }
        return this.props.onOpen(this.props.record);
    }

    /** @param {Event} ev change event of the stage `<select>` */
    onStageChange(ev) {
        if (this.isProvisional) {
            return;
        }
        const stageId = Number(ev.target.value);
        if (stageId && stageId !== this.selectedStageId) {
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
        if (this.isProvisional || !this.props.record.resId) {
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
