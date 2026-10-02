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

import {
    markRaw,
    onMounted,
    onPatched,
    proxy,
    signal,
    status,
    untrack,
    useEffect,
} from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { ConnectionLostError } from "@web/core/network/rpc";
import { usePopover } from "@web/core/popover/popover_hook";
import { user } from "@web/core/user";
import { uniqueId } from "@web/core/utils/functions";
import { hashCode } from "@web/core/utils/strings";
import {
    addFieldDependencies,
    extractFieldsFromArchInfo,
    getScheduleORMExtras,
    makeActiveField,
} from "@web/model/relational_model/utils";
import { formatInteger, formatMonetary } from "@web/views/fields/formatters";
import { OfflineActionHelper } from "@web/views/offline_action_helper";
import { AnimatedNumber } from "@web/views/view_components/animated_number";
import { crmKanbanView } from "@crm/views/crm_kanban/crm_kanban_view";
import { CrmKanbanRenderer } from "@crm/views/crm_kanban/crm_kanban_renderer";
import {
    CRM_MOBILE_ACTIVITY_LIMIT,
    consumeQuickCreateDeepLink,
    crmOwnEffectPromise,
    getCrmActivityLimit,
    getCrmActivitySubfields,
    isFieldMapping,
    setCrmActivityLimit,
    useCrmOffline,
} from "@crm/mobile/crm_offline_hooks";
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
 *   first desktop specification. Crossings during the first root load are checked
 *   once that load has completed: the root is reloaded once if the variant it
 *   applied no longer matches the screen.
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
        /** @type {Promise<void>|null} pending check of reloads asked for before ready */
        this.crmDeferredReload = null;
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
     * Adds the variant hook, the offline-fallback hook and the activity sheet's
     * "Show more" hook to the parent's hooks.
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
                crmLoadMoreActivities: () => this.crmLoadMoreActivities(),
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
            // The activity sheet's rows, in the (cached) root load, with the same
            // `{activeFields, fields}` structure the relational model builds for
            // x2many sub-fields. Fresh definitions: the model owns what it is given.
            const subFields = getCrmActivitySubfields();
            const subActiveFields = {};
            for (const name of Object.keys(subFields)) {
                subActiveFields[name] = makeActiveField();
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
     * The variant a root load started now would apply: the mobile one on a small
     * screen, unless the offline desktop-variant fallback is active (a load started
     * online ends it).
     *
     * @returns {"mobile"|"desktop"}
     */
    crmCurrentVariant() {
        const fallback = this.crmDesktopFallback && this.crmOffline.isOffline();
        return this.crmOffline.isSmall && !fallback ? "mobile" : "desktop";
    }

    /**
     * `onWillLoadRoot` hook: applies the variant matching the current screen size
     * (and offline fallback) to a root configuration and to every group
     * configuration it holds, with fresh objects, so that no shared object is
     * mutated and the records of existing groups also load the new variant. The
     * mobile variant reads at most the activity page size remembered for the
     * root's search (`crmActivityScope`) per lead.
     *
     * @param {Object} config root configuration about to be loaded
     */
    crmApplyVariant(config) {
        if (!this.crmOffline.isOffline()) {
            this.crmDesktopFallback = false;
        }
        const useMobile = this.crmCurrentVariant() === "mobile";
        const { desktop, mobile } = this.crmVariants;
        const variant = useMobile ? mobile : desktop;
        this.crmLastVariant = useMobile ? "mobile" : "desktop";
        // The page size is read from the remembered preference, never from this
        // controller: a pipeline mounted again, even cold and offline, then issues
        // the request of its last visit, whose cache key holds the page "Show more"
        // reached.
        const activityLimit = useMobile
            ? getCrmActivityLimit(this.crmActivityScope(config))
            : CRM_MOBILE_ACTIVITY_LIMIT;
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
            const activeFields = { ...variant.activeFields, ...runtimeExtras };
            if (useMobile && variant.activeFields[ACTIVITY_FIELD.name]) {
                // Bounded activity page, in a fresh entry: the variants stay read-only.
                activeFields[ACTIVITY_FIELD.name] = {
                    ...variant.activeFields[ACTIVITY_FIELD.name],
                    limit: activityLimit,
                };
            }
            cfg.activeFields = markRaw(activeFields);
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
     * Reloads the root, from the effects above, which cannot return the reload: it
     * is owned here (`crmOwnEffectPromise`). A load lost to the connection is
     * ignored: the framework shows its offline helper for an unavailable root. Any
     * other error reaches the framework error handling, once.
     *
     * Until the model is ready, the load in progress is its first one, which applied
     * the variant of the screen when it started. Every call made meanwhile shares one
     * check, owned once by the call that starts it, run when the model becomes
     * ready: it reloads the root once if the variant a load would apply now differs
     * from the one the last root load applied, and does nothing otherwise (crossings
     * that cancel out) or once the controller is destroyed.
     */
    crmReload() {
        if (this.model.isReady()) {
            crmOwnEffectPromise(this.model.load());
            return;
        }
        if (!this.crmDeferredReload) {
            // `whenReady` is resolved after the first successful load, never rejected.
            this.crmDeferredReload = this.model.whenReady.promise.then(() => {
                this.crmDeferredReload = null;
                if (
                    status(this) === "destroyed" ||
                    this.crmLastVariant === this.crmCurrentVariant()
                ) {
                    return;
                }
                return this.model.load();
            });
            crmOwnEffectPromise(this.crmDeferredReload);
        }
    }

    /**
     * Scope of the activity page size remembered for a root load: the view's
     * model and action, and the root's search (domain and grouping). The search
     * is part of the root load's request, hence of its cache key, like the page
     * size: a "Show more" in one search leaves the page size, and so the cached
     * pages, of the action's other searches unchanged.
     *
     * @param {Object} config root configuration
     * @returns {string}
     */
    crmActivityScope(config) {
        const search = hashCode(JSON.stringify([config.domain ?? [], config.groupBy ?? []]));
        return `pipeline:${config.resModel}:${this.env.config?.actionId ?? ""}:${search}`;
    }

    /**
     * `crmLoadMoreActivities` model hook, the activity sheet's "Show more": online
     * on a small screen, with the mobile variant applied, raises the activity rows
     * loaded per lead by one page (`CRM_MOBILE_ACTIVITY_LIMIT`) and reloads the
     * root, so the larger page lands in the root load and its cache. It never
     * issues a separate `mail.activity` read.
     *
     * The raised page size is remembered (`setCrmActivityLimit`) before the
     * reload, which reads it, so that a later root load of the same search,
     * after a reopen, issues the same request and is served the cached larger
     * page offline. The previous page size is remembered again when that page
     * was not loaded: the reload failed (a lost connection resolves, any other
     * error propagates), or the connection was lost and the desktop variant was
     * served instead (`crmDesktopFallback`).
     *
     * @returns {Promise<void>}
     */
    async crmLoadMoreActivities() {
        if (
            !this.crmOffline.isSmall ||
            this.crmOffline.isOffline() ||
            this.crmLastVariant !== "mobile" ||
            !this.model.isReady()
        ) {
            return;
        }
        const scope = this.crmActivityScope(this.model.config);
        const previousLimit = getCrmActivityLimit(scope);
        setCrmActivityLimit(scope, previousLimit + CRM_MOBILE_ACTIVITY_LIMIT);
        try {
            await this.model.load();
        } catch (error) {
            setCrmActivityLimit(scope, previousLimit);
            ignoreConnectionLost(error);
            return;
        }
        if (this.crmDesktopFallback) {
            setCrmActivityLimit(scope, previousLimit);
        }
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
        /** @type {Set<string>} ids of the stage groups whose "Load more" is loading */
        this.crmLoadingMore = proxy(new Set());
        /** @type {{x: number, y: number}|null} start of the current touch gesture */
        this.crmTouch = null;
        this.crmMounted = false;
        this.crmWarmed = false;

        // Reconciliation: after a replay or a discard, the root is reloaded (from
        // the cache offline), so provisional cards become server records and
        // discarded writes stop being projected. No id is remapped.
        // The framework also ends a sync, with nothing to replay, at every web
        // client start and reconnection: the reload follows only syncs that had
        // lead or activity entries waiting for a replay, which is what the
        // pipeline displays. Parked entries (`extras.error`) are not waiting: the
        // framework's sync skips them, and they stay queued until discarded.
        // `hasQueuedEntries` is armed while such entries are queued, and disarmed
        // by the reload after a replay or by a discard that leaves none. Entries
        // leaving the queue during a replay are not discards, so it stays armed
        // until that replay ends.
        const hasEntriesToReplay = () =>
            ["crm.lead", "mail.activity"].some((model) =>
                this.crmOffline.queuedEntries(model).some(({ value }) => !value.extras?.error)
            );
        let hasQueuedEntries = false;
        useEffect(() => {
            if (hasEntriesToReplay()) {
                hasQueuedEntries = true;
            }
        });
        this.crmOffline.onReplayed(() => {
            if (hasQueuedEntries) {
                hasQueuedEntries = false;
                return this.crmReloadIfMobile();
            }
        });
        const disarmAfterDiscard = () => {
            if (!hasEntriesToReplay()) {
                hasQueuedEntries = false;
            }
        };
        this.crmOffline.onEntriesDiscarded("crm.lead", () => {
            disarmAfterDiscard();
            return this.crmReloadIfMobile();
        });
        // No reload for a discarded activity: the cards show no activity, and the
        // activity sheet follows its own discards.
        this.crmOffline.onEntriesDiscarded("mail.activity", disarmAfterDiscard);

        /** Root list whose displayed stage was last checked by `crmEnsureGroupLoaded`. */
        this.crmCheckedRoot = null;

        onMounted(() => {
            this.crmMounted = true;
            this.crmMaybeWarm();
            if (this.isStagePipeline) {
                this.crmCheckedRoot = this.props.list;
                crmOwnEffectPromise(this.crmEnsureGroupLoaded(this.activeGroup));
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
                crmOwnEffectPromise(this.crmEnsureGroupLoaded(this.activeGroup));
            }
        });

        /** "Back" of the uncached-lead helper (the stage body's or the ungrouped one's). */
        this.crmHelperBackRef = signal.ref();
        /** Id of the uncached-lead helper, which describes its "Back" button. */
        this.crmLeadHelperId = uniqueId("o_crm_mobile_pipeline_lead_helper_");
        /**
         * Focus that the next patch moves once it renders its target: the "Back"
         * button of the helper shown for `helperLeadId`, or the open button of the
         * card of `leadId` after "Back".
         *
         * @type {{helperLeadId: number}|{leadId: number}|null}
         */
        this.crmFocusRequest = null;
        onPatched(() => this.crmApplyFocusRequest());

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
     * @override
     * The framework's empty-data helper derives emptiness from the server counts
     * only. The mobile layout also shows the leads created offline and projects
     * the queued writes onto the loaded leads, so it shows the helper only while
     * no lead card shows in any listed stage (or in the ungrouped list). The
     * framework's decision is kept where the framework renders (wide screen,
     * another grouping, a stage grouping without groups) and in sample mode.
     *
     * @returns {boolean}
     */
    get showNoContentHelper() {
        const show = super.showNoContentHelper;
        const { list } = this.props;
        if (
            !show ||
            !this.isMobile ||
            list.model.useSampleModel ||
            (list.isGrouped && !(this.isStagePipeline && this.activeGroup))
        ) {
            return show;
        }
        if (!list.isGrouped) {
            return !this.getUngroupedRecords().length;
        }
        const groups = this.stageGroups;
        if (groups.some((group) => this.crmOffline.pendingCreates(group.value).length)) {
            return false;
        }
        const stageIds = new Set(groups.map((group) => group.value));
        return !this.crmLoadedLeads().some(({ record, group }) =>
            stageIds.has(this.crmProjectedStage(record, group))
        );
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
        return this.crmStageOf(this.crmOffline.projectLead(record), group);
    }

    /**
     * The stage a lead projection is displayed in (rules of `crmProjectedStage`),
     * for a projection already computed.
     *
     * @param {Object|null} projection `projectLead` of the lead's record
     * @param {Object} [group] the group whose list holds the record
     * @returns {number|false|null} the stage id (`false`: no stage), or `null` while
     *  a pending delete or archive hides the lead
     */
    crmStageOf(projection, group) {
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
     * Loaded leads of every group (`crmLoadedLeads`), each projected once: its
     * `projection` (`projectLead`, one queue read) and the `stageId` it is
     * displayed in (`crmStageOf`). Computed on each call, never stored.
     *
     * @returns {{record: Object, group: Object, projection: Object|null, stageId: number|false|null}[]}
     */
    crmProjectedLeads() {
        return this.crmLoadedLeads().map(({ record, group }) => {
            const projection = this.crmOffline.projectLead(record);
            return { record, group, projection, stageId: this.crmStageOf(projection, group) };
        });
    }

    /**
     * Header and cards of a stage for one render, from a single projection of the
     * loaded leads (`crmProjectedLeads`) and a single read of the stage's pending
     * creates, shared by the cards, the count and the revenue. Nothing is stored:
     * the next render reads the queue again.
     *
     * @param {Object} group
     * @returns {{
     *  records: Object[],
     *  pending: Object[],
     *  count: number,
     *  revenue: {value: number, currencies: number[]|undefined}|null,
     * }} `records` as `getStageRecords`, `pending` as `pendingCreates`, `count` as
     *  `getStageCount`, `revenue` as `getStageRevenue`
     */
    crmStageView(group) {
        const leads = this.crmProjectedLeads();
        const pending = this.crmOffline.pendingCreates(group.value);
        return {
            records: this.getStageRecords(group, leads),
            pending,
            count: this.getStageCount(group, leads, pending),
            revenue: this.getStageRevenue(group, leads, pending),
        };
    }

    /**
     * Cards of a stage: the group's loaded leads that stay in it once projected,
     * followed by the leads of other groups projected into it. Hidden leads are
     * left out, and each lead is listed once.
     *
     * @param {Object} group
     * @param {Object[]} [leads] `crmProjectedLeads()` already computed for this render
     * @returns {Object[]} records
     */
    getStageRecords(group, leads) {
        if (!group) {
            return [];
        }
        const own = [];
        const incoming = [];
        for (const { record, group: holder, stageId } of leads ?? this.crmProjectedLeads()) {
            if (stageId !== group.value) {
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
     * @param {Object[]} [leads] `crmProjectedLeads()` already computed for this render
     * @param {Object[]} [pending] `pendingCreates(group.value)` already read for this render
     * @returns {number}
     */
    getStageCount(group, leads, pending) {
        let count = this.props.progressBarState?.getGroupCount(group) ?? group.count;
        count += (pending ?? this.crmOffline.pendingCreates(group.value)).length;
        for (const { group: holder, stageId } of leads ?? this.crmProjectedLeads()) {
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
     *   0 for a group that sums no lead: the server's `false` sum of a stage without
     *   leads (into which leads may since have moved), or no sum at all in a group
     *   the client created or emptied (a new column, the sample data left);
     * - for every lead of the displayed root's server-value snapshot (server stage
     *   and revenue of the leads loaded since that root's load), its server revenue
     *   leaves its server stage and its current (projected) revenue joins its
     *   current stage; a hidden or no longer listed lead joins no stage;
     * - plus the revenue of the leads created offline in the stage.
     *
     * `null` while a progress-bar filter is active (the aggregates are unfiltered)
     * or when the root load aggregated no revenue (offline desktop-variant fallback
     * of an arch without it).
     *
     * @param {Object} group
     * @param {Object[]} [leads] `crmProjectedLeads()` already computed for this render
     * @param {Object[]} [pending] `pendingCreates(group.value)` already read for this render
     * @returns {{value: number, currencies: number[]|undefined}|null}
     */
    getStageRevenue(group, leads, pending) {
        const { progressBarState } = this.props;
        if (progressBarState?.getGroupCount(group) !== undefined) {
            return null;
        }
        const base = group.aggregates?.[REVENUE_FIELD];
        if (
            typeof base !== "number" &&
            !this.props.list.config.fieldsToAggregate?.includes(REVENUE_FIELD)
        ) {
            return null;
        }
        let value = typeof base === "number" ? base : 0;
        // The snapshot of the root whose aggregates are displayed, not the model's
        // `crmServerValues`: a root load (e.g. of a search) installs its root before
        // it waits for its progress bar, and the view displays the previous root
        // until that load ends.
        const serverValues = this.props.list._crmServerValues;
        if (serverValues instanceof Map) {
            for (const { stageId, revenue } of serverValues.values()) {
                if (stageId === group.value) {
                    value -= amount(revenue);
                }
            }
            for (const { record, projection, stageId } of leads ?? this.crmProjectedLeads()) {
                if (!serverValues.has(record.resId)) {
                    continue;
                }
                if (projection && stageId === group.value) {
                    value += amount(projection.expected_revenue);
                }
            }
        }
        for (const create of pending ?? this.crmOffline.pendingCreates(group.value)) {
            value += amount(create.expected_revenue);
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
     * Text of the stage header's status region, which assistive technologies read
     * out when the displayed stage or its count or revenue changes (queued creates,
     * edits and moves, a replay): the final values, never the intermediate ones the
     * animated revenue shows. The revenue part is left out when the header omits it.
     * Labelled values, so the text reads right whatever the count.
     *
     * @param {{count: number, revenue: {value: number, currencies: number[]|undefined}|null}} stageView
     *  `crmStageView(group)` of this render
     * @returns {string}
     */
    crmStageStatus({ count, revenue }) {
        if (!revenue) {
            return _t("Leads: %(count)s", { count });
        }
        return _t("Leads: %(count)s, expected revenue: %(revenue)s", {
            count,
            revenue: this.crmFormatRevenue(revenue),
        });
    }

    /**
     * A stage revenue as the header's `AnimatedNumber` displays it once its
     * animation ends: humanized, in the stage currency (the company's when the
     * stage has several), or as a plain number when it has none.
     *
     * @param {{value: number, currencies: number[]|undefined}} revenue
     * @returns {string}
     */
    crmFormatRevenue({ value, currencies }) {
        if (currencies?.length) {
            return formatMonetary(value, {
                currencyId: currencies.length > 1 ? user.activeCompany.currency_id : currencies[0],
                humanReadable: true,
                digits: [null, 0],
                minDigits: 3,
            });
        }
        return formatInteger(value, { humanReadable: true, minDigits: 3 });
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
     * Leads of a stage left to load by "Load more": the active progress-bar count
     * (a filtered `0` stays `0`, as in the header) or the group count, minus the
     * loaded records. The inherited `getGroupUnloadedCount`, which the desktop
     * columns keep, falls back to the unfiltered count on a filtered `0`.
     *
     * @param {Object} group
     * @returns {number}
     */
    crmGetUnloadedCount(group) {
        const count = this.props.progressBarState?.getGroupCount(group) ?? group.count;
        const loaded = group.list.records.filter((record) => !record.isInQuickCreation);
        return count - loaded.length;
    }

    /**
     * "Load more" (`crmLoadMore`) is offered online only, while the stage has leads
     * left to load.
     *
     * @param {number} unloadedCount `crmGetUnloadedCount` of the stage
     * @returns {boolean}
     */
    showLoadMore(unloadedCount) {
        return !this.crmOffline.isOffline() && unloadedCount > 0;
    }

    /**
     * "Load more" of a stage: the inherited `loadMore`, one at a time per stage. The
     * button stays disabled and busy until the load ends, successful or not; a
     * failure reaches the framework's error handling unchanged.
     *
     * @param {Object} group
     * @returns {Promise<void>}
     */
    async crmLoadMore(group) {
        const { id } = group;
        if (this.crmLoadingMore.has(id)) {
            return;
        }
        this.crmLoadingMore.add(id);
        try {
            await this.loadMore(group);
        } finally {
            this.crmLoadingMore.delete(id);
        }
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
     * offline helper instead, and its "Back" button takes the focus. Provisional
     * cards (no `resId`) do nothing.
     *
     * @param {Object} record
     */
    openLead(record) {
        if (!record?.resId) {
            return;
        }
        if (!this.crmOffline.isLeadAvailableOffline(record.resId)) {
            this.mobile.helperLeadId = record.resId;
            this.crmFocusRequest = { helperLeadId: record.resId };
            return;
        }
        return this.props.openRecord(record);
    }

    /** Leaves the lead helper: the lead's card takes the focus back. */
    closeLeadHelper() {
        const leadId = this.mobile.helperLeadId;
        this.mobile.helperLeadId = false;
        this.crmFocusRequest = leadId ? { leadId } : null;
    }

    /**
     * Moves the focus `openLead` or `closeLeadHelper` requested, once a patch has
     * rendered its target. The card button that opened the helper, and the "Back"
     * button that closes it, leave the DOM with that patch, which would otherwise
     * drop the focus to the document body. "Back" is described by the helper's
     * text, so the reason the form did not open is read with it. A request whose
     * target the patch did not render (the helper left or replaced in the meantime,
     * the lead no longer listed) is dropped.
     */
    crmApplyFocusRequest() {
        const request = this.crmFocusRequest;
        if (!request) {
            return;
        }
        this.crmFocusRequest = null;
        if ("helperLeadId" in request) {
            if (this.mobile.helperLeadId === request.helperLeadId) {
                this.crmHelperBackRef()?.focus();
            }
        } else if (!this.mobile.helperLeadId) {
            this.crmLeadOpenButton(request.leadId)?.focus();
        }
    }

    /**
     * The open button of a lead's card in the displayed body, or `null` when the
     * lead shows no card. The body renders one card per record of
     * `getStageRecords` (then the provisional cards) or of `getUngroupedRecords`,
     * in that order: the n-th record's card is the n-th card.
     *
     * @param {number} leadId
     * @returns {HTMLElement|null}
     */
    crmLeadOpenButton(leadId) {
        let records = [];
        if (this.isStagePipeline) {
            records = this.getStageRecords(this.activeGroup);
        } else if (this.isMobile && !this.props.list.isGrouped) {
            records = this.getUngroupedRecords();
        }
        const index = records.findIndex((record) => record.resId === leadId);
        if (index < 0) {
            return null;
        }
        const cards = this.rootRef()?.querySelectorAll(
            ".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card"
        );
        return cards?.[index]?.querySelector(".o_crm_mobile_lead_open") || null;
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
        const stage = this.stages.find((s) => s.id === stageId);
        const stageValue = { id: stageId, display_name: stage?.display_name ?? "" };
        if (this.isStagePipeline) {
            const groups = this.stageGroups;
            const source = groups.find((group) => group.list.records.includes(record));
            const target = groups.find((group) => group.value === stageId);
            if (!source || !target) {
                return;
            }
            if (source !== target) {
                return this.crmSaveStage(record, stageValue, () =>
                    this.props.list.moveRecord(record.id, source.id, null, target.id)
                );
            }
            holder = source;
        }
        if (this.crmProjectedStage(record, holder) === stageId) {
            return;
        }
        if (many2oneId(record.data.stage_id) === stageId) {
            // The lead still has this (server) stage while a queued write of another
            // `Record` of it (e.g. its form) shows it elsewhere. The record already
            // holds the value, so `record.update` would register no change and save
            // nothing: the choice is written as its own lead write instead, so it
            // wins on replay rather than being ignored.
            return this.crmWriteStage(record, stageValue);
        }
        return this.crmSaveStage(record, stageValue, () =>
            record.update({ stage_id: stageValue }, { save: true })
        );
    }

    /**
     * Saves a stage choice through the framework (`save`: the group move or the
     * record save) and keeps it the lead's last queued stage write.
     *
     * Offline, the framework queues the save under the key of the record's first
     * offline save, with that save's timestamp (or the current one, which writes
     * queued in the same millisecond share), while `crmWriteStage` queues its
     * writes after every queued lead write. Replay and `projectLead` follow
     * `extras.timeStamp`, so another queued stage write of the lead timestamped at
     * or after the choice would win over it: the choice is then also written
     * through `crmWriteStage`, after every queued lead write. An online save, a
     * save that queued nothing and a choice already queued last add nothing. A
     * queued save whose values are not a field-value mapping writes no stage.
     *
     * @param {Object} record
     * @param {{id: number, display_name: string}} stageValue
     * @param {() => Promise} save
     * @returns {Promise} the result of `save`
     */
    async crmSaveStage(record, stageValue, save) {
        const ownEntry = () =>
            this.crmOffline.queuedEntries("crm.lead").find(({ key }) => key === record.offlineId);
        const previous = ownEntry();
        const result = await save();
        const own = ownEntry();
        // The framework stores a new entry object at each queued save.
        if (!own || own === previous || own.value.args?.[1]?.stage_id !== stageValue.id) {
            return result;
        }
        const timeStamp = own.value.extras?.timeStamp || 0;
        const overridden = this.crmOffline
            .queuedEntries("crm.lead")
            .some(
                ({ key, value }) =>
                    key !== own.key &&
                    value.method === "web_save" &&
                    Array.isArray(value.args?.[0]) &&
                    value.args[0].includes(record.resId) &&
                    isFieldMapping(value.args[1]) &&
                    "stage_id" in value.args[1] &&
                    (value.extras?.timeStamp || 0) >= timeStamp
            );
        if (overridden) {
            await this.crmWriteStage(record, stageValue);
        }
        return result;
    }

    /**
     * Writes a stage on a lead through its own `web_save`: online it is saved and
     * the root reloaded; offline (or when the connection drops) it is queued after
     * every queued lead write. Its extras carry, as the framework's record saves
     * do, the display values of the change (`changes`, which `projectLead` reads)
     * and of the stage the lead showed before it (`originalValues`, which the
     * offline systray reads with `changes` for an edit).
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
        // The stage shown before this write: the projected one (queued writes of the
        // lead applied), else the loaded one. Many2one display format, as `changes`.
        const shownStage = this.crmOffline.projectLead(record)?.stage_id ?? record.data.stage_id;
        const shownStageId = many2oneId(shownStage);
        const originalStage = shownStageId && {
            id: shownStageId,
            display_name:
                shownStage.display_name ??
                this.stages.find((stage) => stage.id === shownStageId)?.display_name ??
                "",
        };
        const result = await this.crmOffline.schedule(
            "crm.lead",
            "web_save",
            [[record.resId], { stage_id: stageValue.id }],
            { context: record.context, specification: {} },
            {
                ...extras,
                changes: { stage_id: stageValue },
                originalValues: { stage_id: originalStage },
            }
        );
        if (!this.crmOffline.isQueued(result)) {
            await this.crmReloadIfMobile();
        }
    }

    /**
     * Opens the quick-create bottom sheet on the displayed stage, leaving sample
     * mode first.
     *
     * @param {HTMLElement} [target]
     */
    openQuickCreate(target) {
        const group = this.activeGroup;
        if (!this.canQuickCreate() || !group) {
            return;
        }
        const { model } = this.props.list;
        if (model.useSampleModel) {
            // The sample data leaves when the sheet opens, as when the framework's
            // kanban quick create opens. Offline, the created lead is only queued and
            // no reload ends sample mode, so its provisional card would otherwise
            // show among sample cards, under the sample helper. The sample sums go
            // too (the framework's column headers drop them with the counts): the
            // stage header then sums no lead, as for an empty server stage, and
            // shows the revenue of the leads created offline only.
            model.removeSampleDataInGroups();
            model.useSampleModel = false;
            for (const stageGroup of this.props.list.groups) {
                stageGroup.aggregates = {};
            }
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
