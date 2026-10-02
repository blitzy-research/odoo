/**
 * `crm_mobile_pipeline`: the CRM lead kanban view with a one-stage-at-a-time
 * pipeline on small screens.
 *
 * - Wide screen: the view is the `crm_kanban` view. The controller loads exactly
 *   the specification `crm_kanban` builds from the arch (its "desktop variant"),
 *   and the renderer `t-call`s `web.KanbanRenderer` with its inherited
 *   `CrmKanbanRenderer` behaviour, so the DOM, components, handlers and requests
 *   are those of `crm_kanban`, including after a resize back from a small screen.
 * - Small screen: the controller loads a "mobile variant" of the specification
 *   (card fields the arch lacks, the leads' activity rows and the revenue
 *   aggregate) and the renderer shows one stage at a time, with lead cards, the
 *   provisional cards of leads created offline, a stage header and a bottom-sheet
 *   quick create.
 *
 * Offline state and queue reads go through `useCrmOffline()` only: this module
 * holds no queue, cache or storage of its own. The model, the arch parser and the
 * search model are those of `crm_kanban`.
 */

import { markRaw, onMounted, onPatched, proxy, untrack, useEffect } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { ConnectionLostError } from "@web/core/network/rpc";
import { usePopover } from "@web/core/popover/popover_hook";
import {
    addFieldDependencies,
    extractFieldsFromArchInfo,
    getScheduleORMExtras,
    makeActiveField,
} from "@web/model/relational_model/utils";
import { OfflineActionHelper } from "@web/views/offline_action_helper";
import { AnimatedNumber } from "@web/views/view_components/animated_number";
import { crmKanbanView } from "@crm/views/crm_kanban/crm_kanban_view";
import { CrmKanbanRenderer } from "@crm/views/crm_kanban/crm_kanban_renderer";
import { consumeQuickCreateDeepLink, useCrmOffline } from "@crm/mobile/crm_offline_hooks";
import { CrmMobileLeadCard } from "@crm/mobile/crm_mobile_lead_card/crm_mobile_lead_card";
import { CrmMobileQuickCreate } from "@crm/mobile/crm_mobile_quick_create/crm_mobile_quick_create";

/** Minimal horizontal travel, in px, for a touch gesture to change stage. */
const SWIPE_THRESHOLD = 50;

/**
 * Fields the mobile lead card and stage header display, added to the mobile
 * variant only when the arch does not already load them. `stage_id` is writable
 * so that a stage chosen on a card is saved (readonly values are never saved).
 */
const MOBILE_CARD_FIELDS = Object.freeze([
    Object.freeze({ name: "partner_id", type: "many2one", relation: "res.partner" }),
    Object.freeze({
        name: "expected_revenue",
        type: "monetary",
        currency_field: "company_currency",
    }),
    Object.freeze({ name: "company_currency", type: "many2one", relation: "res.currency" }),
    Object.freeze({ name: "stage_id", type: "many2one", relation: "crm.stage", readonly: false }),
]);

/** The lead activities one2many, added to the mobile variant when the arch lacks it. */
const ACTIVITY_FIELD = Object.freeze({
    name: "activity_ids",
    type: "one2many",
    relation: "mail.activity",
});

/**
 * Activity sub-fields loaded with every lead of the mobile variant, so that the
 * activity sheet has its rows in the (cached) root load. Same structure as the
 * relational model builds for x2many sub-fields: `{activeFields, fields}`.
 */
const ACTIVITY_SUBFIELDS = Object.freeze({
    summary: Object.freeze({ name: "summary", type: "char" }),
    activity_type_id: Object.freeze({
        name: "activity_type_id",
        type: "many2one",
        relation: "mail.activity.type",
    }),
    date_deadline: Object.freeze({ name: "date_deadline", type: "date" }),
    user_id: Object.freeze({ name: "user_id", type: "many2one", relation: "res.users" }),
    state: Object.freeze({
        name: "state",
        type: "selection",
        selection: Object.freeze([
            Object.freeze(["overdue", "Overdue"]),
            Object.freeze(["today", "Today"]),
            Object.freeze(["planned", "Planned"]),
            Object.freeze(["done", "Done"]),
        ]),
    }),
});

/** Aggregate behind the mobile stage header revenue (server sum of every group). */
const REVENUE_FIELD = "expected_revenue";

/**
 * Promise rejection handler: a request lost to a dropped connection is not an
 * error here. The framework already shows its offline helper for a root that
 * could not load (`couldNotLoadRootOffline`); any other error propagates.
 *
 * @param {unknown} error
 */
function ignoreConnectionLost(error) {
    if (!(error instanceof ConnectionLostError)) {
        throw error;
    }
}

/**
 * Reads a many2one value as an id: `{id, display_name}` → `id`, a bare id is kept,
 * `false`/`null` → `false`.
 *
 * @param {Object|number|false|null} value
 * @returns {number|false}
 */
function many2oneId(value) {
    if (value && typeof value === "object") {
        return value.id ?? false;
    }
    return value || false;
}

/**
 * @param {unknown} value
 * @returns {number} `value` when it is a finite number, `0` otherwise
 */
function amount(value) {
    return Number.isFinite(value) ? value : 0;
}

// -----------------------------------------------------------------------------
// Controller
// -----------------------------------------------------------------------------

/**
 * The CRM kanban controller, switching the root load specification between the
 * arch's own ("desktop") variant and the "mobile" variant on every root load.
 *
 * - `onWillLoadRoot` runs before the cache key of every root load is computed,
 *   including `_updateConfig` reloads, so a cached load is looked up with the
 *   variant that is applied; a configuration restored from the action state is
 *   corrected at its next load.
 * - An effect reloads the root whenever the viewport crosses the small-screen
 *   breakpoint, in either direction, so desktop → mobile → desktop ends with the
 *   first desktop specification.
 * - Offline on a small screen, when the mobile variant was never cached but a
 *   wide-layout visit cached the desktop one, `crmUseDesktopSpec()` lets
 *   `CrmKanbanModel.load` retry once with the desktop variant. The fallback ends at
 *   the first online root load, and the root is reloaded when the connection
 *   returns while it is active.
 */
export class CrmMobilePipelineController extends crmKanbanView.Controller {
    setup() {
        // The parent's setup reads `this.modelParams`, which relies on these
        // (`this.props` is already set: it is a class field).
        this.crmOffline = useCrmOffline();
        this.crmDesktopFallback = false;
        /** @type {"mobile"|"desktop"|null} variant applied to the last root load */
        this.crmLastVariant = null;
        this.crmVariants = this.crmComputeVariants();
        super.setup();

        if (this.progressBarState) {
            // `useProgressBar` wraps `model.hooks.onWillLoadRoot` and calls the hook
            // it wraps without its `config` argument (progress_bar_hook.js), so the
            // variant of a kanban with a progress bar is applied from here, outside
            // that wrapper, on every root load.
            const hooks = this.model.hooks;
            const onWillLoadRoot = hooks.onWillLoadRoot;
            hooks.onWillLoadRoot = (config) => {
                onWillLoadRoot(config);
                this.crmApplyVariant(config);
            };
        }

        // Viewport: the specification follows the screen size in both directions.
        let wasSmall = this.crmOffline.isSmall;
        useEffect(() => {
            const isSmall = this.crmOffline.isSmall;
            if (isSmall !== wasSmall) {
                wasSmall = isSmall;
                untrack(() => this.crmReload());
            }
        });

        // Reconnection: leave the offline desktop-variant fallback.
        let wasOffline = this.crmOffline.isOffline();
        useEffect(() => {
            const isOffline = this.crmOffline.isOffline();
            const reconnected = wasOffline && !isOffline;
            wasOffline = isOffline;
            if (reconnected && this.crmDesktopFallback) {
                untrack(() => this.crmReload());
            }
        });
    }

    /**
     * @override
     * Adds the variant hook and the offline-fallback hook to the parent's hooks.
     */
    get modelParams() {
        const params = super.modelParams;
        const onWillLoadRoot = params.hooks?.onWillLoadRoot;
        return {
            ...params,
            hooks: {
                ...params.hooks,
                onWillLoadRoot: (config) => {
                    onWillLoadRoot?.(config);
                    // Called without config through the progress bar wrapper, which
                    // `setup` handles.
                    if (config) {
                        this.crmApplyVariant(config);
                    }
                },
                crmUseDesktopSpec: () => this.crmUseDesktopSpec(),
            },
        };
    }

    /**
     * Builds the two load-specification variants, each from its own run of the
     * parent's recipe (`KanbanController.modelParams`), so they share no object:
     * - `desktop` is exactly what `crm_kanban` loads for the arch;
     * - `mobile` adds the card fields the arch lacks, the leads' activity rows and
     *   the `expected_revenue` aggregate.
     * Both are read-only once built.
     *
     * @returns {{desktop: Object, mobile: Object}} each `{activeFields, fields, fieldsToAggregate}`
     */
    crmComputeVariants() {
        const build = () => {
            const { archInfo } = this.props;
            // `extractFieldsFromArchInfo` and `addFieldDependencies` add missing
            // definitions to the `fields` object they receive: work on a copy.
            const { activeFields, fields } = extractFieldsFromArchInfo(archInfo, {
                ...this.props.fields,
            });
            if (archInfo.cardColorField) {
                addFieldDependencies(activeFields, fields, [
                    { name: archInfo.cardColorField, type: "integer" },
                ]);
            }
            addFieldDependencies(activeFields, fields, this.progressBarAggregateFields);
            return {
                activeFields,
                fields,
                fieldsToAggregate: this.progressBarAggregateFields.map((field) => field.name),
            };
        };
        const desktop = build();
        const mobile = build();
        // Only fields the model has are requested: a field already loaded by the
        // arch is left as the arch declares it (adding it again would patch it).
        const modelFields = this.props.fields;
        const missing = MOBILE_CARD_FIELDS.filter(
            (field) => !(field.name in mobile.activeFields) && field.name in modelFields
        );
        addFieldDependencies(mobile.activeFields, mobile.fields, missing);
        if (!(ACTIVITY_FIELD.name in mobile.activeFields) && ACTIVITY_FIELD.name in modelFields) {
            addFieldDependencies(mobile.activeFields, mobile.fields, [ACTIVITY_FIELD]);
        }
        const activityField = mobile.activeFields[ACTIVITY_FIELD.name];
        if (activityField) {
            const related = activityField.related || { activeFields: {}, fields: {} };
            const subActiveFields = {};
            const subFields = {};
            for (const [name, field] of Object.entries(ACTIVITY_SUBFIELDS)) {
                subActiveFields[name] = makeActiveField();
                // Mutable copies: the model owns the definitions it is given.
                subFields[name] = { ...field };
                if (field.selection) {
                    subFields[name].selection = field.selection.map((option) => [...option]);
                }
            }
            activityField.related = {
                activeFields: { ...related.activeFields, ...subActiveFields },
                fields: { ...related.fields, ...subFields },
            };
        }
        if (!mobile.fieldsToAggregate.includes(REVENUE_FIELD) && REVENUE_FIELD in modelFields) {
            mobile.fieldsToAggregate.push(REVENUE_FIELD);
        }
        return { desktop, mobile };
    }

    /**
     * `onWillLoadRoot` hook: applies the variant matching the current screen size
     * (and offline fallback) to a root configuration and to every group
     * configuration it holds, with fresh objects, so that no shared object is
     * mutated and the records of existing groups also load the new variant.
     *
     * @param {Object} config root configuration about to be loaded
     */
    crmApplyVariant(config) {
        if (!this.crmOffline.isOffline()) {
            this.crmDesktopFallback = false;
        }
        const useMobile = this.crmOffline.isSmall && !this.crmDesktopFallback;
        const { desktop, mobile } = this.crmVariants;
        const variant = useMobile ? mobile : desktop;
        this.crmLastVariant = useMobile ? "mobile" : "desktop";
        // Group configurations are created once (`_postprocessReadGroup`) with
        // references to the root's objects and never refreshed: assign them too.
        const assign = (cfg) => {
            // Keep what the model added at runtime (e.g. a properties field for a
            // properties group-by), which neither variant knows about.
            const runtimeExtras = {};
            for (const [name, activeField] of Object.entries(cfg.activeFields || {})) {
                if (!(name in desktop.activeFields) && !(name in mobile.activeFields)) {
                    runtimeExtras[name] = activeField;
                }
            }
            cfg.activeFields = markRaw({ ...variant.activeFields, ...runtimeExtras });
            cfg.fields = markRaw({ ...cfg.fields, ...variant.fields });
            cfg.fieldsToAggregate = [...variant.fieldsToAggregate];
            for (const groupConfig of Object.values(cfg.groups || {})) {
                groupConfig.activeFields = cfg.activeFields;
                groupConfig.fields = cfg.fields;
                groupConfig.fieldsToAggregate = cfg.fieldsToAggregate;
                if (groupConfig.list) {
                    assign(groupConfig.list);
                }
            }
        };
        assign(config);
    }

    /**
     * `crmUseDesktopSpec` model hook, called by `CrmKanbanModel.load` when a root
     * load failed with a lost connection. Returns `true` once, when the failed load
     * used the mobile variant offline on a small screen: the model then retries
     * with the desktop variant, which a wide-layout visit may have cached.
     *
     * @returns {boolean}
     */
    crmUseDesktopSpec() {
        if (
            this.crmOffline.isSmall &&
            this.crmOffline.isOffline() &&
            this.crmLastVariant === "mobile" &&
            !this.crmDesktopFallback
        ) {
            this.crmDesktopFallback = true;
            return true;
        }
        return false;
    }

    /**
     * Reloads the root (once the model is ready). A load lost to the connection
     * resolves: the framework shows its offline helper for an unavailable root.
     *
     * @returns {Promise<void>}
     */
    crmReload() {
        if (!this.model.isReady()) {
            return Promise.resolve();
        }
        return this.model.load().catch(ignoreConnectionLost);
    }
}

// -----------------------------------------------------------------------------
// Renderer
// -----------------------------------------------------------------------------

/**
 * Renderer of `crm_mobile_pipeline` (template `crm.CrmMobilePipeline`).
 *
 * Not small: `t-call="web.KanbanRenderer"` with the inherited `CrmKanbanRenderer`
 * behaviour, and none of the mobile effects below act. Small and grouped by
 * stage: one stage at a time ("stage pipeline"). Small and ungrouped: the lead
 * cards in one column.
 *
 * What the cards and the header show is the loaded data with the framework
 * queue projected onto it (`useCrmOffline().projectLead`): a lead whose queued
 * write moves it to another stage is listed and counted there, a lead whose
 * delete or archive is pending is hidden, and leads created offline show as
 * provisional cards.
 */
export class CrmMobilePipeline extends CrmKanbanRenderer {
    static template = "crm.CrmMobilePipeline";
    // The inherited components keep the desktop `t-call` of web.KanbanRenderer working.
    static components = {
        ...CrmKanbanRenderer.components,
        CrmMobileLeadCard,
        OfflineActionHelper,
        AnimatedNumber,
    };

    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
        /** `activeIndex` of `stageGroups`; `helperLeadId` of the uncached lead shown */
        this.mobile = proxy({ activeIndex: 0, helperLeadId: false });
        this.quickCreate = usePopover(CrmMobileQuickCreate, { useBottomSheet: true });
        /** @type {{x: number, y: number}|null} start of the current touch gesture */
        this.crmTouch = null;
        this.crmMounted = false;
        this.crmWarmed = false;

        // Reconciliation: after a replay or a discard, the root is reloaded (from
        // the cache offline), so provisional cards become server records and
        // discarded writes stop being projected. No id is remapped.
        // The framework also ends a sync, with nothing to replay, at every web
        // client start and reconnection: the reload follows only syncs that had
        // lead or activity entries queued, which is what the pipeline displays.
        let hasQueuedEntries = false;
        useEffect(() => {
            if (
                this.crmOffline.queuedEntries("crm.lead").length ||
                this.crmOffline.queuedEntries("mail.activity").length
            ) {
                hasQueuedEntries = true;
            }
        });
        this.crmOffline.onReplayed(() => {
            if (hasQueuedEntries) {
                hasQueuedEntries = false;
                this.crmReloadIfMobile();
            }
        });
        this.crmOffline.onEntriesDiscarded("crm.lead", () => this.crmReloadIfMobile());

        /** Root list whose displayed stage was last checked by `crmEnsureGroupLoaded`. */
        this.crmCheckedRoot = null;

        onMounted(() => {
            this.crmMounted = true;
            this.crmMaybeWarm();
            if (this.isStagePipeline) {
                this.crmCheckedRoot = this.props.list;
                this.crmEnsureGroupLoaded(this.activeGroup);
                // Consumed by the stage pipeline only: a wide screen keeps the
                // "New Lead" shortcut flag untouched and opens no sheet.
                if (consumeQuickCreateDeepLink() && this.canQuickCreate()) {
                    this.openQuickCreate();
                }
            }
        });

        // A root reload (search, reconciliation, or the variant reload when the
        // screen turns small) brings new groups, folded as the server returns them:
        // the displayed stage of each new root is loaded.
        onPatched(() => {
            if (this.isStagePipeline && this.props.list !== this.crmCheckedRoot) {
                this.crmCheckedRoot = this.props.list;
                this.crmEnsureGroupLoaded(this.activeGroup);
            }
        });

        let wasMobile = this.isMobile;
        useEffect(() => {
            const isMobile = this.isMobile;
            const isOffline = this.crmOffline.isOffline();
            const turnedMobile = isMobile && !wasMobile;
            const turnedDesktop = !isMobile && wasMobile;
            wasMobile = isMobile;
            if (!this.crmMounted) {
                return;
            }
            if (turnedDesktop) {
                // Mobile UI exists only on small screens: the sheet does not stay
                // over the desktop kanban.
                untrack(() => this.quickCreate.close());
            }
            if (isMobile && !isOffline) {
                untrack(() => this.crmMaybeWarm());
            }
            if (turnedMobile) {
                // The controller reloads the root with the mobile variant: its
                // displayed stage is loaded once that root arrives (`onPatched`).
                // Toggling a group of the current root would race that reload, whose
                // response re-folds the group while the toggle marks it unfolded.
                untrack(() => {
                    this.crmCheckedRoot = this.props.list;
                });
            }
        });
    }

    // -------------------------------------------------------------------------
    // Getters
    // -------------------------------------------------------------------------

    /** Small-screen layout, read live (follows viewport changes). */
    get isMobile() {
        return this.crmOffline.isSmall;
    }

    /** Small screen and grouped by stage: one stage at a time. */
    get isStagePipeline() {
        const { list } = this.props;
        return this.isMobile && list.isGrouped && list.groupByField?.name === "stage_id";
    }

    /** Groups in display order (the "no stage" group first), `[]` when ungrouped. */
    get stageGroups() {
        if (!this.props.list.isGrouped) {
            return [];
        }
        return this.getGroupsOrRecords().map(({ group }) => group);
    }

    /** `mobile.activeIndex` clamped to the current groups. */
    get activeIndex() {
        const count = this.stageGroups.length;
        if (!count) {
            return 0;
        }
        return Math.min(Math.max(this.mobile.activeIndex, 0), count - 1);
    }

    /** The displayed stage group, or `null` when there is none. */
    get activeGroup() {
        return this.stageGroups[this.activeIndex] || null;
    }

    get hasPreviousStage() {
        return this.activeIndex > 0;
    }

    get hasNextStage() {
        return this.activeIndex < this.stageGroups.length - 1;
    }

    /**
     * Stage choices of the cards and the quick create, `{id, display_name}`: the
     * stage groups (without the "no stage" group) on the stage pipeline, the
     * distinct stages of the loaded records otherwise.
     *
     * @returns {{id: number, display_name: string}[]}
     */
    get stages() {
        if (this.isStagePipeline) {
            return this.stageGroups
                .filter((group) => group.value)
                .map((group) => ({ id: group.value, display_name: group.displayName }));
        }
        const stages = new Map();
        for (const record of this.props.list.records) {
            const stage = record.data.stage_id;
            if (stage?.id && !stages.has(stage.id)) {
                stages.set(stage.id, { id: stage.id, display_name: stage.display_name });
            }
        }
        return [...stages.values()];
    }

    // -------------------------------------------------------------------------
    // Mobile effects
    // -------------------------------------------------------------------------

    /**
     * Caches the activity types once per instance, when mounted on a small screen
     * and online. This request is mobile-only: it is never issued on a wide screen.
     */
    crmMaybeWarm() {
        if (this.crmWarmed || !this.crmMounted || !this.isMobile || this.crmOffline.isOffline()) {
            return;
        }
        this.crmWarmed = true;
        this.crmOffline.warmActivityTypes();
    }

    /**
     * Reloads the root through the existing model on a small screen (served from
     * the cache offline).
     *
     * @returns {Promise<void>|undefined}
     */
    crmReloadIfMobile() {
        if (!this.isMobile) {
            return;
        }
        return this.props.list.model.load().catch(ignoreConnectionLost);
    }

    /**
     * Opens a folded stage whose leads were never loaded. Online this loads them;
     * offline the CRM record list issues no request and the stage shows the
     * offline helper. A folded stage whose leads were loaded keeps its cards.
     *
     * @param {Object|null} group
     * @returns {Promise<void>|undefined}
     */
    crmEnsureGroupLoaded(group) {
        if (group?.isFolded && group.count > 0 && !group.list.records.length) {
            return Promise.resolve(this.toggleGroup(group)).catch(ignoreConnectionLost);
        }
    }

    // -------------------------------------------------------------------------
    // Navigation
    // -------------------------------------------------------------------------

    /**
     * Shows the stage at `index` (clamped), leaving any lead helper.
     *
     * @param {number} index
     */
    async goToStage(index) {
        const count = this.stageGroups.length;
        if (!count) {
            return;
        }
        this.mobile.activeIndex = Math.min(Math.max(index, 0), count - 1);
        this.mobile.helperLeadId = false;
        await this.crmEnsureGroupLoaded(this.activeGroup);
    }

    /** @param {TouchEvent} ev */
    onTouchStart(ev) {
        const touch = ev.touches?.[0];
        this.crmTouch = touch ? { x: touch.clientX, y: touch.clientY } : null;
    }

    /**
     * A mostly horizontal swipe of at least `SWIPE_THRESHOLD` px shows the next
     * stage (swipe left) or the previous one (swipe right).
     *
     * @param {TouchEvent} ev
     */
    onTouchEnd(ev) {
        const start = this.crmTouch;
        this.crmTouch = null;
        const touch = ev.changedTouches?.[0];
        if (!start || !touch) {
            return;
        }
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
            return this.goToStage(this.activeIndex + (dx < 0 ? 1 : -1));
        }
    }

    // -------------------------------------------------------------------------
    // Projected data (loaded records + framework queue)
    // -------------------------------------------------------------------------

    /**
     * The stage a loaded lead is displayed in, once its queued writes are applied.
     *
     * @param {Object} record
     * @param {Object} [group] the group whose list holds `record`
     * @returns {number|false|null} the stage id (`false`: no stage), or `null` while
     *  a pending delete or archive hides the lead
     */
    crmProjectedStage(record, group) {
        const projection = this.crmOffline.projectLead(record);
        if (!projection) {
            return null;
        }
        if (projection.stage_id === undefined) {
            // Stage not loaded (offline desktop-variant fallback): the group's.
            return group ? group.value : false;
        }
        return many2oneId(projection.stage_id);
    }

    /**
     * Loaded leads of every group (quick-create drafts excluded), each with the
     * group whose list holds it.
     *
     * @returns {{record: Object, group: Object}[]}
     */
    crmLoadedLeads() {
        const leads = [];
        for (const group of this.stageGroups) {
            for (const record of group.list.records) {
                if (!record.isInQuickCreation) {
                    leads.push({ record, group });
                }
            }
        }
        return leads;
    }

    /**
     * Cards of a stage: the group's loaded leads that stay in it once projected,
     * followed by the leads of other groups projected into it. Hidden leads are
     * left out, and each lead is listed once.
     *
     * @param {Object} group
     * @returns {Object[]} records
     */
    getStageRecords(group) {
        if (!group) {
            return [];
        }
        const own = [];
        const incoming = [];
        for (const { record, group: holder } of this.crmLoadedLeads()) {
            if (this.crmProjectedStage(record, holder) !== group.value) {
                continue;
            }
            (holder === group ? own : incoming).push(record);
        }
        const seen = new Set();
        return [...own, ...incoming].filter((record) => {
            if (seen.has(record.resId)) {
                return false;
            }
            seen.add(record.resId);
            return true;
        });
    }

    /**
     * Cards of an ungrouped list: the loaded leads whose projection is visible.
     *
     * @returns {Object[]} records
     */
    getUngroupedRecords() {
        return this.props.list.records.filter(
            (record) => !record.isInQuickCreation && this.crmOffline.projectLead(record) !== null
        );
    }

    /**
     * Lead count of a stage header: the active progress-bar count (a filtered `0`
     * stays `0`) or the group count, plus the leads created offline in it, minus
     * its loaded leads hidden or projected elsewhere, plus the loaded leads of
     * other groups projected into it. Framework moves already adjust `group.count`.
     *
     * @param {Object} group
     * @returns {number}
     */
    getStageCount(group) {
        let count = this.props.progressBarState?.getGroupCount(group) ?? group.count;
        count += this.crmOffline.pendingCreates(group.value).length;
        for (const { record, group: holder } of this.crmLoadedLeads()) {
            const stageId = this.crmProjectedStage(record, holder);
            if (holder === group && stageId !== group.value) {
                count--;
            } else if (holder !== group && stageId === group.value) {
                count++;
            }
        }
        return Math.max(count, 0);
    }

    /**
     * Revenue of a stage header, computed the same way online and offline:
     * - base: the server sum `group.aggregates.expected_revenue` of the root load;
     * - for every lead of `list.model.crmServerValues` (server stage and revenue of
     *   the leads loaded since the last root load), its server revenue leaves its
     *   server stage and its current (projected) revenue joins its current stage;
     *   a hidden or no longer listed lead joins no stage;
     * - plus the revenue of the leads created offline in the stage.
     *
     * `null` while a progress-bar filter is active (the aggregates are unfiltered)
     * or when no server sum was loaded (offline desktop-variant fallback).
     *
     * @param {Object} group
     * @returns {{value: number, currencies: number[]|undefined}|null}
     */
    getStageRevenue(group) {
        const { progressBarState } = this.props;
        if (progressBarState?.getGroupCount(group) !== undefined) {
            return null;
        }
        const base = group.aggregates?.[REVENUE_FIELD];
        if (typeof base !== "number") {
            return null;
        }
        let value = base;
        const serverValues = this.props.list.model.crmServerValues;
        if (serverValues instanceof Map) {
            for (const { stageId, revenue } of serverValues.values()) {
                if (stageId === group.value) {
                    value -= amount(revenue);
                }
            }
            for (const { record, group: holder } of this.crmLoadedLeads()) {
                if (!serverValues.has(record.resId)) {
                    continue;
                }
                const projection = this.crmOffline.projectLead(record);
                if (projection && this.crmProjectedStage(record, holder) === group.value) {
                    value += amount(projection.expected_revenue);
                }
            }
        }
        for (const pending of this.crmOffline.pendingCreates(group.value)) {
            value += amount(pending.expected_revenue);
        }
        return { value, currencies: this.crmStageCurrencies(group) };
    }

    /**
     * Currencies of a stage revenue: on an arch with a progress-bar sum field, the
     * ones the desktop column header uses (`getAggregateValue`); otherwise, or
     * while those are not loaded (offline), the currency the loaded leads share.
     *
     * @param {Object} group
     * @returns {number[]|undefined}
     */
    crmStageCurrencies(group) {
        const { progressBarState } = this.props;
        const sumField = progressBarState?.progressAttributes?.sumField;
        if (sumField) {
            const { currencies } = progressBarState.getAggregateValue(group, sumField);
            if (currencies?.length) {
                return currencies;
            }
        }
        const currencyIds = new Set();
        for (const { record } of this.crmLoadedLeads()) {
            const currencyId = record.data.company_currency?.id;
            if (currencyId) {
                currencyIds.add(currencyId);
            }
        }
        return currencyIds.size === 1 ? [...currencyIds] : undefined;
    }

    /**
     * Offline, a stage with leads none of which was ever loaded.
     *
     * @param {Object} group
     */
    isStageUnavailableOffline(group) {
        return this.crmOffline.isOffline() && group.count > 0 && group.list.records.length === 0;
    }

    /**
     * "Load more" (inherited `loadMore`) is offered online only.
     *
     * @param {Object} group
     */
    showLoadMore(group) {
        return !this.crmOffline.isOffline() && this.getGroupUnloadedCount(group) > 0;
    }

    /**
     * The currently loaded record of a lead, across the groups (passed to the cards,
     * whose activity sheet reads the live record after every reload).
     *
     * @param {number} resId
     * @returns {Object|null}
     */
    getRecord(resId) {
        const { list } = this.props;
        const lists = list.isGrouped ? this.stageGroups.map((group) => group.list) : [list];
        for (const recordList of lists) {
            const record = recordList.records.find((r) => r.resId === resId);
            if (record) {
                return record;
            }
        }
        return null;
    }

    // -------------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------------

    /**
     * Opens a lead's form; offline, a lead whose form was never visited shows the
     * offline helper instead. Provisional cards (no `resId`) do nothing.
     *
     * @param {Object} record
     */
    openLead(record) {
        if (!record?.resId) {
            return;
        }
        if (!this.crmOffline.isLeadAvailableOffline(record.resId)) {
            this.mobile.helperLeadId = record.resId;
            return;
        }
        return this.props.openRecord(record);
    }

    closeLeadHelper() {
        this.mobile.helperLeadId = false;
    }

    /**
     * Moves a lead to a stage. On the stage pipeline this is the framework's move
     * (queued offline, the CRM model skips its rainbowman lookup); on an ungrouped
     * list the record saves its new stage.
     *
     * @param {Object} record
     * @param {number} stageId
     * @returns {Promise|undefined}
     */
    moveLead(record, stageId) {
        let holder;
        if (this.isStagePipeline) {
            const groups = this.stageGroups;
            const source = groups.find((group) => group.list.records.includes(record));
            const target = groups.find((group) => group.value === stageId);
            if (!source || !target) {
                return;
            }
            if (source !== target) {
                return this.props.list.moveRecord(record.id, source.id, null, target.id);
            }
            holder = source;
        }
        if (this.crmProjectedStage(record, holder) === stageId) {
            return;
        }
        const stage = this.stages.find((s) => s.id === stageId);
        const stageValue = { id: stageId, display_name: stage?.display_name ?? "" };
        if (many2oneId(record.data.stage_id) === stageId) {
            // The lead still has this (server) stage while a queued write of another
            // `Record` of it (e.g. its form) shows it elsewhere. The record already
            // holds the value, so `record.update` would register no change and save
            // nothing: the choice is written as its own lead write instead, so it
            // wins on replay rather than being ignored.
            return this.crmWriteStage(record, stageValue);
        }
        return record.update({ stage_id: stageValue }, { save: true });
    }

    /**
     * Writes a stage on a lead through its own `web_save`: online it is saved and
     * the root reloaded; offline (or when the connection drops) it is queued after
     * every queued lead write, with the display values `projectLead` reads.
     *
     * @param {Object} record
     * @param {{id: number, display_name: string}} stageValue
     */
    async crmWriteStage(record, stageValue) {
        const extras = getScheduleORMExtras(record.model, [record]);
        // Replay follows `extras.timeStamp`: after the writes it overrides, even when
        // the clock has not moved since they were queued.
        for (const { value } of this.crmOffline.queuedEntries("crm.lead")) {
            extras.timeStamp = Math.max(extras.timeStamp, (value.extras?.timeStamp || 0) + 1);
        }
        const result = await this.crmOffline.schedule(
            "crm.lead",
            "web_save",
            [[record.resId], { stage_id: stageValue.id }],
            { context: record.context, specification: {} },
            { ...extras, changes: { stage_id: stageValue } }
        );
        if (!this.crmOffline.isQueued(result)) {
            await this.crmReloadIfMobile();
        }
    }

    /**
     * Opens the quick-create bottom sheet on the displayed stage.
     *
     * @param {HTMLElement} [target]
     */
    openQuickCreate(target) {
        const group = this.activeGroup;
        if (!this.canQuickCreate() || !group) {
            return;
        }
        this.quickCreate.open(target || this.rootRef(), {
            stages: this.stages,
            defaultStageId: group.value,
            onSave: (values) => this.onQuickCreateSave(values),
        });
    }

    /**
     * Creates the lead: online it is saved and the pipeline reloads; offline it is
     * queued with its display values (the provisional card). An online server error
     * rejects, so the sheet keeps the entered values. Then shows the chosen stage.
     *
     * @param {Object} values the six quick-create values (`stage_id` is an id)
     */
    async onQuickCreateSave(values) {
        const stage = this.stages.find((s) => s.id === values.stage_id);
        const { actionId, actionName } = this.env.config || {};
        await this.crmOffline.createLead(this.props.list, values, {
            actionId,
            actionName,
            viewType: "kanban",
            displayName: values.name,
            changes: {
                ...values,
                stage_id: stage ? { id: stage.id, display_name: stage.display_name } : false,
            },
        });
        const index = this.stageGroups.findIndex((group) => group.value === values.stage_id);
        if (index >= 0) {
            this.mobile.activeIndex = index;
        }
    }
}

// -----------------------------------------------------------------------------
// View
// -----------------------------------------------------------------------------

/**
 * The `crm_kanban` view (model `CrmKanbanModel`, arch parser `CrmKanbanArchParser`,
 * default kanban search model, `crm.Kanban.Buttons`) with the controller and
 * renderer above.
 */
export const crmMobilePipelineView = {
    ...crmKanbanView,
    Controller: CrmMobilePipelineController,
    Renderer: CrmMobilePipeline,
};

registry.category("views").add("crm_mobile_pipeline", crmMobilePipelineView);
