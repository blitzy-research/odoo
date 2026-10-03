/** Mobile stage-pipeline rendering with framework kanban fallback on wide screens. */

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
    getCrmActivitySubfields,
    isFieldMapping,
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

const ACTIVITY_FIELD = Object.freeze({
    name: "activity_ids",
    type: "one2many",
    relation: "mail.activity",
});

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

function amount(value) {
    return Number.isFinite(value) ? value : 0;
}

// -----------------------------------------------------------------------------
// Controller
// -----------------------------------------------------------------------------

/**
 * Selects the arch's desktop or mobile root specification before its cache key is
 * computed. Viewport changes reload the matching variant; uncached offline mobile
 * loads may retry the desktop variant until reconnection.
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

        let wasSmall = this.crmOffline.isSmall;
        useEffect(() => {
            const isSmall = this.crmOffline.isSmall;
            if (isSmall !== wasSmall) {
                wasSmall = isSmall;
                untrack(() => this.crmReload());
            }
        });

        let wasOffline = this.crmOffline.isOffline();
        useEffect(() => {
            const isOffline = this.crmOffline.isOffline();
            const reconnected = wasOffline && !isOffline;
            wasOffline = isOffline;
            if (!reconnected || !this.crmDesktopFallback) {
                return;
            }
            untrack(() => {
                // Fallback recovery is mobile-only: a wide screen already loads the
                // desktop variant, so the fallback just ends.
                if (this.crmOffline.isSmall) {
                    this.crmReload();
                } else {
                    this.crmDesktopFallback = false;
                }
            });
        });
    }

    get modelParams() {
        const params = super.modelParams;
        const onWillLoadRoot = params.hooks?.onWillLoadRoot;
        return {
            ...params,
            hooks: {
                ...params.hooks,
                onWillLoadRoot: (config) => {
                    onWillLoadRoot?.(config);
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
     * Builds the desktop variant (what `crm_kanban` loads for the arch) and the
     * mobile variant (plus the card fields the arch lacks, the activity rows and the
     * revenue aggregate) as independent active-field and aggregate configurations;
     * existing schema field definitions remain shared and must not be mutated.
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
            // Fresh activity sub-field definitions belong to the model receiving them.
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
     * mobile variant reads at most the session's activity page size of the root's
     * search (`crmActivityScope`) per lead.
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
        const activityLimit = useMobile
            ? this.crmOffline.getActivityLimit(this.crmActivityScope(config))
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
     * Owns effect-started reloads and reports non-connection errors once. Before
     * readiness, calls share a deferred variant check: reload only if the current
     * screen requires another variant and the controller survives.
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
     * Scope of the session's activity page size: model/action plus domain/grouping,
     * so searches keep independent root-cache page sizes.
     *
     * @param {Object} config root configuration
     * @returns {string}
     */
    crmActivityScope(config) {
        const search = hashCode(JSON.stringify([config.domain ?? [], config.groupBy ?? []]));
        return `pipeline:${config.resModel}:${this.env.config?.actionId ?? ""}:${search}`;
    }

    /**
     * Online mobile "Show more": raises the session's root-load activity limit by one
     * page and reloads. Restores the previous limit if loading fails or falls back
     * to desktop; rows remain in the root cache.
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
        const previousLimit = this.crmOffline.getActivityLimit(scope);
        this.crmOffline.setActivityLimit(scope, previousLimit + CRM_MOBILE_ACTIVITY_LIMIT);
        try {
            await this.model.load();
        } catch (error) {
            this.crmOffline.setActivityLimit(scope, previousLimit);
            ignoreConnectionLost(error);
            return;
        }
        if (this.crmDesktopFallback) {
            this.crmOffline.setActivityLimit(scope, previousLimit);
        }
    }
}

// -----------------------------------------------------------------------------
// Renderer
// -----------------------------------------------------------------------------

/**
 * Wide screens reuse the framework kanban and no mobile effect acts there; small
 * screens render stage or ungrouped cards with live queued-write projections.
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
        this.mobile = proxy({ activeIndex: 0, helperLeadId: false });
        this.quickCreate = usePopover(CrmMobileQuickCreate, { useBottomSheet: true });
        /** @type {Set<string>} ids of the stage groups whose "Load more" is loading */
        this.crmLoadingMore = proxy(new Set());
        /** @type {{x: number, y: number}|null} start of the current touch gesture */
        this.crmTouch = null;
        this.crmMounted = false;

        // Reconciliation reload: ignore empty and parked-only syncs. Arm while
        // replayable CRM entries are queued on a small screen; keep armed until the
        // sync ends, or disarm when a discard leaves none. A wide screen neither
        // reads the queue nor stays armed: turning small reloads the root anyway.
        const hasEntriesToReplay = () =>
            ["crm.lead", "mail.activity"].some((model) =>
                this.crmOffline.queuedEntries(model).some(({ value }) => !value.extras?.error)
            );
        let hasQueuedEntries = false;
        useEffect(() => {
            if (!this.isMobile) {
                hasQueuedEntries = false;
                return;
            }
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
            if (!this.isMobile || !hasEntriesToReplay()) {
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

        this.crmHelperBackRef = signal.ref();
        this.crmLeadHelperId = uniqueId("o_crm_mobile_pipeline_lead_helper_");
        /**
         * Focus target for the next patch: helper Back, or the reopened lead card.
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

    get isMobile() {
        return this.crmOffline.isSmall;
    }

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

    get activeIndex() {
        const count = this.stageGroups.length;
        if (!count) {
            return 0;
        }
        return Math.min(Math.max(this.mobile.activeIndex, 0), count - 1);
    }

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
     * Framework counts omit provisional/projected cards. In the mobile layout, show
     * the empty helper only when no card remains; preserve framework decisions
     * elsewhere and in sample mode.
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
     * Mobile-only activity-type warm-up, when mounted and online. The shared hook
     * warms once per session and retries after a failure, so a reconnection or a
     * return to a small screen tries again.
     */
    crmMaybeWarm() {
        if (!this.crmMounted || !this.isMobile || this.crmOffline.isOffline()) {
            return;
        }
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
     * Announces the final stage count/revenue through the status region, not
     * intermediate animated values.
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

    closeLeadHelper() {
        const leadId = this.mobile.helperLeadId;
        this.mobile.helperLeadId = false;
        this.crmFocusRequest = leadId ? { leadId } : null;
    }

    /**
     * Applies requested focus after patching; helper/card replacement would otherwise
     * leave focus on the body. Drops requests whose targets disappeared.
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
     * list the record saves its new stage. A stage id that is not a positive
     * integer of an offered stage (`stages`) is ignored: nothing changes, and
     * nothing is saved or queued.
     *
     * @param {Object} record
     * @param {number} stageId
     * @returns {Promise|undefined}
     */
    moveLead(record, stageId) {
        const stage =
            Number.isSafeInteger(stageId) && stageId > 0
                ? this.stages.find((s) => s.id === stageId)
                : undefined;
        if (!stage) {
            return;
        }
        let holder;
        const stageValue = { id: stage.id, display_name: stage.display_name ?? "" };
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
     * Keeps a saved stage choice last in replay order. If another queued stage write
     * ties or follows the framework save's reused timestamp, appends an explicit
     * `crmWriteStage`; unchanged or already-last choices add nothing.
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
            // Leave sample mode before creating offline: no server reload will remove
            // sample cards or aggregates. Clear them so only provisional revenue is
            // shown.
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
     * The sheet keeps the stages it opened with, so a stage no longer among the
     * current ones (`false` only while none is) is refused before any request.
     *
     * @param {Object} values the six quick-create values (`stage_id` is an id)
     * @returns {Promise<false|undefined>} `false` when the stage is refused
     */
    async onQuickCreateSave(values) {
        const stages = this.stages;
        const stage = stages.find((s) => s.id === values.stage_id);
        if (!stage && (stages.length || values.stage_id !== false)) {
            return false;
        }
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

/** Reuses the CRM kanban model, arch parser and search model. */
export const crmMobilePipelineView = {
    ...crmKanbanView,
    Controller: CrmMobilePipelineController,
    Renderer: CrmMobilePipeline,
};

registry.category("views").add("crm_mobile_pipeline", crmMobilePipelineView);
