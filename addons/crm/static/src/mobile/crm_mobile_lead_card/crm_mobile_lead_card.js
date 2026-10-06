import {
    Component,
    computed,
    onMounted,
    onPatched,
    onWillPatch,
    onWillStart,
    onWillUnmount,
    proxy,
    signal,
    status,
    toRaw,
    untrack,
    useEffect,
} from "@odoo/owl";
import { browser } from "@web/core/browser/browser";
import { deserializeDate, formatDate, serializeDate } from "@web/core/l10n/dates";
import { _t } from "@web/core/l10n/translation";
import { usePopover } from "@web/core/popover/popover_hook";
import { user } from "@web/core/user";
import { useViewportChange } from "@web/core/utils/dvu";
import { uniqueId } from "@web/core/utils/functions";
import { useBus } from "@web/core/utils/hooks";
import { formatMonetary } from "@web/views/fields/formatters";
import {
    crmReturnFocusFromSheet,
    useCrmFocusKeeper,
    useCrmOffline,
    useCrmSheetFocus,
} from "@crm/mobile/crm_offline_hooks";

const { DateTime } = luxon;

/**
 * Delay, in ms, between the display of a lead card and the first text of its
 * status region. A live region announces changes of its text, not the text it is
 * inserted with: the region is rendered empty, so that assistive technology
 * registers it, and its text arrives in a later task. 100 ms is the delay the
 * common live announcers use for the same reason.
 */
export const CRM_SYNC_STATUS_DELAY = 100;

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
 * Name a lead card shows, for the accessible names of its controls.
 *
 * @param {{name?: unknown}} values display values of the card
 * @returns {string} the trimmed name, or `""` for a lead without one
 */
function leadName(values) {
    return typeof values.name === "string" ? values.name.trim() : "";
}

/**
 * Lists loaded and queued lead activities and delegates writes to the shared hooks.
 * Resolve displayed data through `getLeadRecord` on every render because the sheet
 * retains props while reloads replace records. Close when the lead disappears; read
 * options from the relational-field cache, or without it the types from the server
 * online, again whenever the connection drops or returns.
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
     * Content of the sheet (`t-ref="this.rootRef"`, inside the bottom sheet's body)
     * and its heading, for its keyboard focus and its scrolling.
     */
    rootRef = signal(null);
    headingRef = signal(null);

    /**
     * Unique per sheet, so the form controls referenced by their labels' `for`
     * and the invalid-field messages referenced by `aria-describedby` never share
     * an id with another sheet's.
     */
    fieldIdPrefix = uniqueId("o_crm_mobile_activity_form_");

    setup() {
        this.crmOffline = useCrmOffline();
        useCrmSheetFocus(this.rootRef, this.headingRef);
        // A control that disables itself or is replaced ("Mark done", the openers
        // and the buttons of the schedule form, "Show more") hands the focus on.
        // While its request runs, the heading holds the focus inside the sheet.
        useCrmFocusKeeper(this.rootRef, {
            describe: (el, root) => this.describeFocus(el, root),
            candidates: (lost, root) => this.focusCandidates(lost, root),
            park: () => this.headingRef(),
        });
        /** @type {string|null} selector of the action that opened the schedule form */
        this.formOpener = null;
        this.state = proxy({
            // Bumped by `refresh()` and after each write; every getter reading the
            // lead record reads it first, so the render subscribes to it.
            version: 0,
            types: [],
            // Whether the read that gave `types` started offline: the reason shown
            // for a missing type follows that read, not the live connection, until
            // the reread a connectivity change starts is applied.
            typesReadOffline: false,
            assignees: [],
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
            loadingMore: false,
        });
        // Memoize repeated template reads; invalidate from the live record, queue,
        // options and completion state.
        this.activityDataMemo = computed(() => this.computeActivityData());
        this.syncedRowsMemo = computed(() => this.computeSyncedRows());
        this.closed = false;
        /** Numbers of the last options read started and of the last one applied. */
        this.optionsReads = 0;
        this.optionsApplied = 0;
        /** Activity types of the last applied read, offered once no form is open. */
        this.readTypes = [];
        /** Whether the last applied read started offline (`state.typesReadOffline`). */
        this.readTypesOffline = false;
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
        onMounted(() => {
            // The bottom sheet measures and positions its rail in its own
            // `onMounted`, which runs after this one: expand the sheet once it has.
            Promise.resolve().then(() => {
                if (!this.closed && status(this) === "mounted") {
                    this.expandSheet();
                }
            });
        });
        /** Set by the form openers: the next patch reveals the form and focuses its type. */
        this.formToReveal = false;
        /**
         * `[fieldName, ref]` of the field Save focused as the first invalid one: the
         * next patch, which renders its message, reveals both.
         *
         * @type {[string, Function]|null}
         */
        this.fieldToReveal = null;
        // Whether the rail was at its end before a patch. Rows added by a reload or
        // by "Show more" grow the sheet below the viewport, where the rail's scroll
        // position alone would leave the actions row: the patch then scrolls the
        // rail back to its end (browsers without scroll anchoring, such as Safari,
        // would not).
        let wasExpanded = false;
        onWillPatch(() => {
            wasExpanded = this.isSheetExpanded();
        });
        onPatched(() => {
            const revealForm = this.formToReveal;
            const invalidField = this.fieldToReveal;
            this.formToReveal = false;
            this.fieldToReveal = null;
            if (this.closed) {
                return;
            }
            const form = revealForm && this.rootRef()?.querySelector(".o_crm_mobile_activity_form");
            if (form) {
                this.revealElement(form);
                this.typeRef()?.focus({ preventScroll: true });
            } else if (invalidField?.[1]()) {
                const [fieldName, fieldRef] = invalidField;
                this.revealElement(fieldRef());
                this.rootRef()
                    ?.querySelector(`[id="${this.fieldId(`${fieldName}_feedback`)}"]`)
                    ?.scrollIntoView({ block: "nearest" });
            } else if (wasExpanded && !this.isSheetExpanded()) {
                this.expandSheet();
            }
        });
        // The bottom sheet re-measures on a viewport change (phone keyboard,
        // rotation) without moving its rail; this listener runs after its own.
        useViewportChange(() => {
            if (!this.closed && status(this) === "mounted") {
                const focused = document.activeElement;
                this.revealElement(this.isRevealedOnFocus(focused) ? focused : null);
            }
        });
        // Once mounted, the sheet follows its lead reactively: the opener's models
        // replace their records without a bus event (a form pager move reloads the
        // root silently), so it closes as soon as `getLeadRecord()` returns nothing.
        useEffect(() => {
            const leadGone = !this.props.getLeadRecord();
            if (leadGone && status(this) === "mounted") {
                untrack(() => this.closeIfLeadGone());
            }
        });
        // Reread options when warm-up completes and whenever connectivity drops or
        // returns: without relational-field cache, the types read online are not
        // available offline, so a drop leaves the openers disabled with their reason;
        // with the cache, a reread hits only the cache. `onWillStart` owns the
        // initial read.
        let seenRevision = null;
        let wasOffline = false;
        useEffect(() => {
            const revision = this.crmOffline.activityTypesRevision();
            const offline = this.crmOffline.isOffline();
            const reread =
                seenRevision !== null && (revision !== seenRevision || offline !== wasOffline);
            seenRevision = revision;
            wasOffline = offline;
            if (reread) {
                untrack(() => this.reloadOptions());
            }
        });
    }

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
     * Scrolls the bottom sheet's rail to the sheet's own snap point, where the sheet
     * is fully expanded: its bottom edge meets the viewport's, so the sticky actions
     * row (or the form's Save/Cancel row) is in view however tall the content is.
     * The sheet element is the scroll target, so only the rail moves: the body's
     * scroll position is kept. Nothing moves while the sheet slides out.
     */
    expandSheet() {
        this.rootRef()
            ?.closest(".o_bottom_sheet:not(.o_bottom_sheet_dismissing) .o_bottom_sheet_sheet")
            ?.scrollIntoView({ block: "start" });
    }

    /** @returns {boolean} whether the bottom sheet's rail is scrolled to its end */
    isSheetExpanded() {
        const rail = this.rootRef()?.closest(".o_bottom_sheet_rail");
        return Boolean(rail) && rail.scrollTop >= rail.scrollHeight - rail.clientHeight - 1;
    }

    /**
     * Expands the sheet, then scrolls `el` into the view of the sheet's body, above
     * the sticky row of buttons (the body's `scroll-padding-block-end`).
     *
     * @param {Element|null|undefined} el
     */
    revealElement(el) {
        this.expandSheet();
        el?.scrollIntoView({ block: "nearest" });
    }

    /**
     * @param {Element|null} el
     * @returns {boolean} whether `el` is a control of the sheet outside its sticky
     *  rows of buttons, which are always in view
     */
    isRevealedOnFocus(el) {
        return Boolean(
            el &&
                this.rootRef()?.contains(el) &&
                !el.closest(".o_crm_mobile_activity_actions, .o_crm_mobile_activity_form_buttons")
        );
    }

    /**
     * A control focused by a tap, Tab or a script is revealed above the sticky row.
     *
     * @param {FocusEvent} ev
     */
    onFocusIn(ev) {
        if (this.isRevealedOnFocus(ev.target)) {
            this.revealElement(ev.target);
        }
    }

    /**
     * Reads the activity types and the assignees through `getActivityTypes()` and
     * `getAssignees()`: from the relational-field cache (no RPC, online or offline),
     * or, without that cache, the types from the server online and none offline.
     * Reads may overlap: one is applied only when no later-started read was applied
     * before it, and none once the sheet is destroyed. A read finding no type leaves
     * an open form its type options, so its type `<select>` is never empty;
     * `closeForm()` then offers that read. Whether the read started offline is
     * applied with its types (`state.typesReadOffline`), so the reason given for a
     * missing type always describes the read that found it missing.
     */
    async loadOptions() {
        const read = ++this.optionsReads;
        const offline = this.crmOffline.isOffline();
        const [types, assignees] = await Promise.all([
            this.crmOffline.getActivityTypes(),
            this.crmOffline.getAssignees(),
        ]);
        if (read < this.optionsApplied || status(this) === "destroyed") {
            return;
        }
        this.optionsApplied = read;
        this.readTypes = types;
        this.readTypesOffline = offline;
        if (types.length || !this.state.form) {
            this.state.types = types;
            this.state.typesReadOffline = offline;
        }
        this.state.assignees = assignees;
    }

    async reloadOptions() {
        try {
            await this.loadOptions();
        } catch {
            // A refresh of options already read at startup: when they cannot be
            // read, the sheet keeps the options it shows.
        }
    }

    /** @returns {Object|null|undefined} the lead record currently loaded by the opener */
    get leadRecord() {
        void this.state.version;
        return this.props.getLeadRecord();
    }

    /**
     * Activity data for the opener's current lead, or `null` without loaded activity data.
     *
     * @returns {{rows: Object[], moreCount: number, variant: string}|null}
     */
    computeActivityData() {
        const record = this.leadRecord;
        return record ? this.crmOffline.activityRows(record) : null;
    }

    get activityData() {
        return this.activityDataMemo();
    }

    /**
     * Synced rows with labels and queued/busy completion state; omit successfully
     * completed online rows. Each row's pending completion is one lookup in the
     * hooks' shared queue index (`isActivityDonePending`).
     *
     * @returns {Object[]}
     */
    computeSyncedRows() {
        const rows = (this.activityData?.rows || []).filter(
            (row) => !this.state.doneOnline[row.id]
        );
        return rows.map((row) => {
            const syncedRow = {
                ...row,
                donePending: this.crmOffline.isActivityDonePending(row.id),
                doneBusy: Boolean(this.state.doneBusy[row.id]),
                typeLabel: this.typeLabel(row.activity_type_id),
                deadlineLabel: this.deadlineLabel(row.date_deadline),
                assigneeLabel: this.assigneeLabel(row.user_id),
            };
            return { ...syncedRow, doneAriaLabel: this.doneAriaLabel(syncedRow) };
        });
    }

    get syncedRows() {
        return this.syncedRowsMemo();
    }

    /**
     * Activities queued offline on this lead, labelled like synced rows (type,
     * deadline, assignee). They come from the queue, not from the record, so parked
     * ones survive every reload.
     */
    get pendingRows() {
        void this.state.version;
        return this.crmOffline.pendingActivities(this.props.leadId).map((row) => ({
            ...row,
            typeLabel: this.typeLabel(row.activity_type_id),
            deadlineLabel: this.deadlineLabel(row.date_deadline),
            assigneeLabel: this.assigneeLabel(row.user_id),
        }));
    }

    /** Number of activities not included in the loaded rows, for either load variant. */
    get moreCount() {
        return this.activityData?.moreCount || 0;
    }

    /** Remaining count beside the online "Show more", singular for one activity. */
    get moreCountLabel() {
        const count = this.moreCount;
        return count === 1 ? _t("1 more activity") : _t("%s more activities", count);
    }

    /** Remaining count that only a sync can load, singular for one activity. */
    get moreAfterSyncLabel() {
        const count = this.moreCount;
        return count === 1
            ? _t("1 more activity after sync")
            : _t("%s more activities after sync", count);
    }

    /**
     * True when the lead carries no activity data at all (seen online only in a
     * wide-layout form): the sheet then explains that activities load after sync,
     * and scheduling stays available.
     */
    get hasNoActivityData() {
        return this.activityData === null;
    }

    /**
     * True when the lead's activity data is loaded and lists nothing: no synced
     * row, no activity queued offline and none left to load. The sheet then says
     * that the lead has no activities, and scheduling stays available. Never
     * together with `hasNoActivityData`, which knows nothing of the activities.
     */
    get hasNoActivities() {
        return (
            this.activityData !== null &&
            !this.moreCount &&
            !this.syncedRows.length &&
            !this.pendingRows.length
        );
    }

    get hasTypes() {
        return this.state.types.length > 0;
    }

    get canLogCall() {
        const { callTypeId } = this.props;
        return (
            this.hasTypes &&
            Boolean(callTypeId) &&
            this.state.types.some((type) => type.id === callTypeId)
        );
    }

    /**
     * Why the schedule openers are disabled, shown above them and referenced by
     * the disabled ones: without types, both are; with types but not the arch's
     * Call type, "Log a call" alone is. The wording follows the read that gave
     * the types shown (`state.typesReadOffline`), not the live connection, so a
     * connectivity change keeps the previous reason until its reread is applied:
     * read offline, the missing types come with the next online visit; read
     * online, the server offers none (or not Call, e.g. archived). `""` when no
     * opener is disabled for a missing type, including when the arch names no
     * Call type.
     *
     * @returns {string}
     */
    get typesNotice() {
        const offline = this.state.typesReadOffline;
        if (!this.hasTypes) {
            return offline
                ? _t("Activity types load after sync")
                : _t("No activity type is available");
        }
        if (this.props.callTypeId && !this.canLogCall) {
            return offline
                ? _t("The Call activity type loads after sync")
                : _t("The Call activity type is not available");
        }
        return "";
    }

    /**
     * Additional pages are requested only online through the opener root-load hook
     * (`crmLoadMoreActivities`); offline only the currently loaded page is shown.
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
     * Accessible name of a synced row's done button: its visible label followed
     * by the activity title the row shows, so that the done buttons of the sheet
     * are told apart; the visible label alone for a row without a title.
     *
     * @param {{summary?: string|false, typeLabel: string, donePending: boolean}} row
     * @returns {string}
     */
    doneAriaLabel(row) {
        const activity = String(row.summary || row.typeLabel || "").trim();
        if (row.donePending) {
            return activity
                ? _t("Done · Pending sync: %(activity)s", { activity })
                : _t("Done · Pending sync");
        }
        return activity ? _t("Mark done: %(activity)s", { activity }) : _t("Mark done");
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
     * @param {string} name a form field name, `<field>_feedback` for its message,
     *  or `types_notice` for the reason the openers are disabled
     * @returns {string} DOM id of that element, unique to this sheet
     */
    fieldId(name) {
        return `${this.fieldIdPrefix}_${name}`;
    }

    /**
     * What the focus keeper remembers of the focused control before a patch: the
     * position of a "Mark done" button, or for "Show more" the position of the
     * first one it loads. Nothing for the other controls. `null` for the patch
     * opening the schedule form: the form's reveal gives its type the focus.
     *
     * @param {HTMLElement} el
     * @param {HTMLElement} root
     * @returns {{doneIndex?: number}|null}
     */
    describeFocus(el, root) {
        if (this.formToReveal) {
            return null;
        }
        const doneButtons = [...root.querySelectorAll(".o_crm_mobile_activity_done")];
        if (el.matches(".o_crm_mobile_activity_done")) {
            return { doneIndex: doneButtons.indexOf(el) };
        }
        if (el.matches(".o_crm_mobile_activities_load_more")) {
            return { doneIndex: doneButtons.length };
        }
        return {};
    }

    /**
     * Where the focus goes when a patch disabled or removed the focused control:
     * - from "Mark done": the next "Mark done" (the one now at its position when its
     *   row left), then the previous ones, nearest first;
     * - then, and from any other control: the first control of the open schedule
     *   form (it replaced its openers), the action that opened the form last (the
     *   form left on Cancel or Save), "Log a call", "Schedule follow-up", and the
     *   sheet's heading.
     *
     * @param {import("@crm/mobile/crm_offline_hooks").CrmLostFocus} lost
     * @param {HTMLElement} root
     * @returns {(HTMLElement|null)[]}
     */
    focusCandidates({ el, info }, root) {
        const fallbacks = [
            this.typeRef(),
            this.formOpener && root.querySelector(this.formOpener),
            root.querySelector(".o_crm_mobile_log_call"),
            root.querySelector(".o_crm_mobile_schedule_followup"),
            this.headingRef(),
        ];
        if (!(info.doneIndex >= 0)) {
            return fallbacks;
        }
        const doneButtons = [...root.querySelectorAll(".o_crm_mobile_activity_done")];
        const index = el.isConnected ? doneButtons.indexOf(el) : info.doneIndex;
        const next = el.isConnected ? index + 1 : index;
        return [
            ...doneButtons.slice(next),
            ...doneButtons.slice(0, Math.max(index, 0)).reverse(),
            ...fallbacks,
        ];
    }

    /**
     * Opens the form on the arch's Call type (`mail.mail_activity_data_call`),
     * selected by id: To-Do precedes Call in sequence, so position is meaningless.
     * The new form starts with no field flagged invalid; once rendered, it is
     * scrolled into view and its type takes the focus. Like every write control of
     * the sheet, inert offline where the queue cannot hold a call (non-secure
     * origin), as its disabled button shows.
     */
    openLogCall() {
        if (!this.canLogCall || this.crmOffline.isOfflineQueueBlocked()) {
            return;
        }
        this.formOpener = ".o_crm_mobile_log_call";
        this.state.invalid = {};
        this.state.form = {
            activity_type_id: this.props.callTypeId,
            summary: _t("Call"),
            date_deadline: serializeDate(DateTime.local()),
            user_id: user.userId,
        };
        this.formToReveal = true;
    }

    /**
     * Opens the form on the first cached type, due tomorrow, with no field
     * flagged invalid; once rendered, it is revealed as by `openLogCall`. Inert
     * where the offline queue is blocked (`openLogCall`).
     */
    openFollowUp() {
        if (!this.hasTypes || this.crmOffline.isOfflineQueueBlocked()) {
            return;
        }
        this.formOpener = ".o_crm_mobile_schedule_followup";
        this.state.invalid = {};
        this.state.form = {
            activity_type_id: this.state.types[0].id,
            summary: "",
            date_deadline: serializeDate(DateTime.local().plus({ days: 1 })),
            user_id: user.userId,
        };
        this.formToReveal = true;
    }

    /**
     * Update a draft field and clear its validation error.
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
        this.closeForm();
    }

    /**
     * Closes the schedule form, clearing its invalid-field flags, and offers the
     * types of the last options read, with that read's connectivity for the
     * reason shown: when it found none, both openers are disabled.
     */
    closeForm() {
        this.state.invalid = {};
        this.state.form = null;
        this.state.types = this.readTypes;
        this.state.typesReadOffline = this.readTypesOffline;
    }

    /**
     * Validate type/assignee against available options and the deadline as a server
     * date. Invalid values preserve the draft, flag fields and focus the first error,
     * revealed with its message once that renders; return `null`. The summary is
     * trimmed, and false when empty, as the form view sends an empty char field.
     *
     * @param {{activity_type_id: unknown, summary: unknown, date_deadline: unknown, user_id: unknown}} form
     * @returns {{activity_type_id: number, summary: string|false, date_deadline: string, user_id: number}|null}
     */
    validateForm(form) {
        const vals = {
            activity_type_id: optionId(form.activity_type_id, this.state.types),
            summary: String(form.summary ?? "").trim() || false,
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
        this.fieldToReveal = firstInvalid;
        return null;
    }

    /**
     * Validate and schedule for the current lead through the shared hooks, which own
     * online refresh. Invalid values and server errors preserve the draft; a missing
     * lead closes the sheet once. Where the offline queue is blocked (`openLogCall`)
     * nothing happens and the draft stays.
     */
    async saveForm() {
        const { form } = this.state;
        if (this.state.saving || !form || this.crmOffline.isOfflineQueueBlocked()) {
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
                this.closeForm();
            }
        } finally {
            this.state.saving = false;
            this.state.version++;
        }
    }

    /**
     * Prevents concurrent completions and repeats after a successful or queued
     * completion; a failed request remains retryable. The queued state is read live
     * (`isActivityDonePending`), not from the row, which may come from an earlier
     * render. A server-committed completion (`state.doneOnline`) removes the row even
     * when the lead reload that follows fails or is lost. Inert where the offline
     * queue is blocked (`openLogCall`).
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
            this.crmOffline.isActivityDonePending(id) ||
            this.crmOffline.isOfflineQueueBlocked()
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
 * Keys (`KeyboardEvent.key`) with which the browser selects another option of a
 * closed `<select>` in place, typed characters aside (see `onStageKeydown`).
 */
const SELECT_VALUE_KEYS = Object.freeze(
    new Set([
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
    ])
);

/**
 * Mobile lead card with live queued-write projection and sync status. Provisional
 * cards cannot open, move or schedule until synced.
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
        // A stage chosen with the keyboard on the closed selector (see
        // `onStageKeydown`): whether its next `change` comes from such a key, and the
        // chosen option's value, shown by the selector but not saved yet.
        this.stageKeyChange = false;
        /** @type {string|null} */
        this.pendingStageValue = null;
        // usePopover closes the sheet when this card unmounts. The sheet stays
        // open across a reload only because the pipeline keys its cards by
        // `record.resId`, so the reloaded card is the same component.
        this.activitiesSheet = usePopover(CrmMobileLeadActivities, {
            useBottomSheet: true,
            // Without an env, the overlay's env provider is attached to the web
            // client's root and never released: every closed sheet (components, DOM
            // and listeners) would stay in memory. This one is released on close.
            env: this.env,
            onClose: () => this.onActivitiesClosed(),
        });
        /** @type {HTMLElement|null} control that opened the activity sheet */
        this.activitiesOpener = null;
        // Ids of the visually hidden descriptions of the card's controls
        // (`aria-describedby`), unique to this card.
        this.descriptionId = uniqueId("o_crm_mobile_lead_description_");
        this.unavailableId = uniqueId("o_crm_mobile_lead_unavailable_");
        // The status region stays empty until the card has been displayed for
        // `CRM_SYNC_STATUS_DELAY`, so that the state of a card shown already pending
        // (a provisional card, a pipeline shown again after an offline edit) is
        // announced as well; later changes of a displayed card are announced at once.
        this.syncStatusReady = signal(false);
        let syncStatusTimeout = null;
        onMounted(() => {
            syncStatusTimeout = browser.setTimeout(
                () => this.syncStatusReady.set(true),
                CRM_SYNC_STATUS_DELAY
            );
        });
        onWillUnmount(() => browser.clearTimeout(syncStatusTimeout));
    }

    get isProvisional() {
        return Boolean(this.props.provisional);
    }

    /**
     * The card shows a sample record of an empty pipeline (the model's sample
     * mode), which is inert and hidden from assistive technology, as the framework
     * kanban presents its sample records. A provisional card has no record, so it
     * is never a sample.
     *
     * @returns {boolean}
     */
    get isSample() {
        return Boolean(this.props.record?.model.useSampleModel);
    }

    /**
     * Display values `{name, partner_id, contact_name, expected_revenue,
     * stage_id}`: the provisional values, else the record projected with its
     * queued writes. `null` while a pending, non-parked delete or archive hides
     * the card (a parked one leaves it visible with "Sync failed"), and for a card
     * given neither `record` nor `provisional`, which renders nothing.
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
     * the lead and one sync-state read for its badge, status region and
     * descriptions, whatever the number of stage options. `null` when the card
     * renders nothing (see `values`).
     *
     * @returns {{values: Object, partnerLabel: string, revenueLabel: string,
     *  stage: {id: number|false, missing: boolean, label: string}|null,
     *  syncState: "failed"|"pending"|false, syncStatus: string,
     *  openAriaLabel: string|false, openDescription: string,
     *  openDescribedBy: string|false, unavailableReason: string,
     *  stageAriaLabel: string, activitiesAriaLabel: string}|null}
     */
    get cardData() {
        const values = this.values;
        if (!values) {
            return null;
        }
        const partnerLabel = this.partnerLabel(values);
        const revenueLabel = this.revenueLabel(values);
        const syncState = this.syncState;
        const openDescription = this.openDescription(values, revenueLabel, syncState);
        const describedBy = [
            openDescription && this.descriptionId,
            this.isProvisional && this.unavailableId,
        ].filter(Boolean);
        return {
            values,
            partnerLabel,
            revenueLabel,
            stage: this.stageChoice(values, syncState),
            syncState,
            syncStatus: this.syncStatus(values, syncState),
            openAriaLabel: leadName(values) || false,
            openDescription,
            openDescribedBy: describedBy.join(" ") || false,
            unavailableReason: this.isProvisional ? _t("Available once synced") : "",
            stageAriaLabel: this.stageAriaLabel(values),
            activitiesAriaLabel: this.activitiesAriaLabel(values),
        };
    }

    /**
     * Text of the card's status region: "Pending sync" or "Sync failed" followed by
     * the lead name, so that the announcements of several cards are told apart (the
     * state alone for a lead without a name); empty without a queued write, and
     * until the card has been displayed (`syncStatusReady`).
     *
     * @param {Object} values display values (see `values`)
     * @param {"failed"|"pending"|false} syncState
     * @returns {string}
     */
    syncStatus(values, syncState) {
        // The readiness is read only for a card with a state to announce, so the
        // end of the delay renders no card that has nothing to announce.
        if (!syncState || !this.syncStatusReady()) {
            return "";
        }
        const lead = leadName(values);
        if (syncState === "failed") {
            return lead ? _t("Sync failed: %(lead)s", { lead }) : _t("Sync failed");
        }
        return lead ? _t("Pending sync: %(lead)s", { lead }) : _t("Pending sync");
    }

    /**
     * Description of the open button, named after the lead alone: the partner (or
     * contact) and the expected revenue it shows, each with its label, then the
     * sync state of the badge, which assistive technology does not read.
     *
     * @param {Object} values display values (see `values`)
     * @param {string} revenueLabel the formatted revenue (see `revenueLabel`)
     * @param {"failed"|"pending"|false} syncState
     * @returns {string} `""` when the card shows none of them
     */
    openDescription(values, revenueLabel, syncState) {
        const parts = [];
        const customer = values.partner_id?.display_name;
        if (customer) {
            parts.push(_t("Customer: %(customer)s", { customer }));
        } else if (values.contact_name) {
            parts.push(_t("Contact: %(contact)s", { contact: values.contact_name }));
        }
        if (revenueLabel) {
            parts.push(_t("Expected revenue: %(revenue)s", { revenue: revenueLabel }));
        }
        if (syncState === "failed") {
            parts.push(_t("Sync failed"));
        } else if (syncState) {
            parts.push(_t("Pending sync"));
        }
        return parts.join(", ");
    }

    partnerLabel(values) {
        const { partner_id, contact_name } = values;
        return partner_id?.display_name || contact_name || "";
    }

    /**
     * Empty when the revenue was not loaded (desktop-variant offline fallback).
     * A synced card shows it in its record's `company_currency`. A provisional
     * card has no record yet, so it uses the active company's currency: the
     * active company is the default company of created records, and the server
     * computes `company_currency` from the lead's company (or the current one).
     *
     * @param {Object} values display values (see `values`)
     */
    revenueLabel(values) {
        const revenue = values.expected_revenue;
        if (revenue === undefined) {
            return "";
        }
        return formatMonetary(revenue, {
            currencyId: this.isProvisional
                ? user.activeCompany?.currency_id
                : this.props.record?.data.company_currency?.id,
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
     * Any other stage reads its name, also while the lead's writes (or its
     * provisional create) are pending, and "Stage unavailable" once one of them is
     * parked (`syncState` "failed": its replay was refused, as it is for a stage
     * deleted on the server), so that a stage the server no longer lists is never
     * named.
     *
     * @param {Object} values display values (see `values`)
     * @param {"failed"|"pending"|false} [syncState=false] the card's sync state
     *  (see `syncState`)
     * @returns {{id: number|false, missing: boolean, label: string}|null}
     */
    stageChoice(values, syncState = false) {
        if (values.stage_id === undefined || !this.props.stages.length) {
            return null;
        }
        const id = this.selectedStageId(values);
        const missing = !this.props.stages.some((stage) => stage.id === id);
        let label = "";
        if (missing) {
            if (!id) {
                label = _t("None");
            } else {
                label =
                    syncState === "failed"
                        ? _t("Stage unavailable")
                        : values.stage_id.display_name || "";
            }
        }
        return { id, missing, label };
    }

    /**
     * Accessible name of the stage selector: "Stage" followed by the lead name, so
     * that the selectors of the cards are told apart; "Stage" alone for a lead
     * without a name.
     *
     * @param {Object} values display values (see `values`)
     * @returns {string}
     */
    stageAriaLabel(values) {
        const lead = leadName(values);
        return lead ? _t("Stage of %(lead)s", { lead }) : _t("Stage");
    }

    /**
     * Accessible name of the icon-only activities button: its "Activities" title
     * followed by the lead name, so that the buttons of the cards are told apart;
     * "Activities" alone for a lead without a name.
     *
     * @param {Object} values display values (see `values`)
     * @returns {string}
     */
    activitiesAriaLabel(values) {
        const lead = leadName(values);
        return lead ? _t("Activities: %(lead)s", { lead }) : _t("Activities");
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

    /**
     * A stage chosen on the open option list, by pointer or touch, moves the lead
     * at once. A key that changes the closed selector's value (see
     * `onStageKeydown`) only makes that option the pending choice: the selector
     * shows it, and nothing is saved until it is confirmed.
     *
     * @param {Event} ev change event of the stage `<select>`
     */
    onStageChange(ev) {
        if (this.isProvisional || !this.props.record) {
            return;
        }
        if (this.stageKeyChange) {
            this.stageKeyChange = false;
            this.pendingStageValue = ev.target.value;
            return;
        }
        this.pendingStageValue = null;
        return this.moveToStage(ev.target.value);
    }

    /**
     * The browser changes a closed `<select>`'s value, and fires `change`, at each
     * arrow, Home, End, PageUp and PageDown key and at each typed character
     * (type-to-select), so a lead would move at every step of a keyboard walk
     * through the stages. Such a key flags the `change` it causes as a pending
     * choice, until its keyup. Enter saves the pending choice (and then does
     * nothing else), Escape drops it and shows the lead's stage again, and leaving
     * the selector saves it (`onStageBlur`). Space, and the combinations with Alt,
     * Ctrl or Meta, are not flagged: Space and Alt+ArrowDown open the option list,
     * whose choice is explicit and moves the lead at once.
     *
     * @param {KeyboardEvent} ev
     */
    onStageKeydown(ev) {
        const { key } = ev;
        if (key === "Enter") {
            if (this.pendingStageValue !== null) {
                ev.preventDefault();
                return this.commitPendingStage(ev.currentTarget);
            }
            return;
        }
        if (key === "Escape") {
            this.revertPendingStage(ev.currentTarget);
            return;
        }
        // `key` is missing from the incomplete keydown some browsers fire.
        this.stageKeyChange =
            typeof key === "string" &&
            !ev.altKey &&
            !ev.ctrlKey &&
            !ev.metaKey &&
            (SELECT_VALUE_KEYS.has(key) || (key.length === 1 && key !== " "));
    }

    onStageKeyup() {
        this.stageKeyChange = false;
    }

    /** @param {FocusEvent} ev blur event of the stage `<select>` */
    onStageBlur(ev) {
        this.stageKeyChange = false;
        if (status(this) !== "destroyed") {
            return this.commitPendingStage(ev.currentTarget);
        }
    }

    /**
     * Saves the pending choice, if the selector still shows it: a render that
     * changed its selected option meanwhile (the lead's stage changed) drops it.
     *
     * @param {HTMLSelectElement} select
     */
    commitPendingStage(select) {
        const value = this.pendingStageValue;
        this.pendingStageValue = null;
        if (value !== null && select.value === value) {
            return this.moveToStage(value);
        }
    }

    /**
     * Drops the pending choice and shows the lead's stage again on the selector
     * (its unselectable current option when the stage is none of the choices).
     *
     * @param {HTMLSelectElement} select
     */
    revertPendingStage(select) {
        if (this.pendingStageValue === null) {
            return;
        }
        this.pendingStageValue = null;
        const values = this.values;
        const stage = values && this.stageChoice(values);
        if (stage) {
            select.value = stage.missing ? "" : String(stage.id);
        }
    }

    /**
     * Moves the lead to a chosen stage, unless it already shows it.
     *
     * @param {string} value value of the chosen option
     */
    moveToStage(value) {
        if (this.isProvisional || !this.props.record) {
            return;
        }
        const values = this.values;
        const stageId = Number(value);
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
        // Once opened: opening closes a sheet still open, which forgets its opener.
        this.activitiesOpener = ev.currentTarget;
    }

    /**
     * Every close of the activity sheet (Escape, backdrop, swipe, or its lead
     * gone) gives the focus back to the activities button, else to the card's open
     * button. When the card itself is gone, the pipeline moves the focus on.
     */
    onActivitiesClosed() {
        const opener = this.activitiesOpener;
        this.activitiesOpener = null;
        crmReturnFocusFromSheet([
            opener,
            opener?.closest(".o_crm_mobile_lead_card")?.querySelector(".o_crm_mobile_lead_open"),
        ]);
    }
}
