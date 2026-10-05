/** Mobile stage-pipeline rendering with framework kanban fallback on wide screens. */

import {
    markRaw,
    onMounted,
    onPatched,
    onWillPatch,
    onWillUpdateProps,
    proxy,
    signal,
    status,
    toRaw,
    untrack,
    useEffect,
} from "@odoo/owl";
import { getActiveHotkey } from "@web/core/hotkeys/hotkey_service";
import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { ConnectionLostError } from "@web/core/network/rpc";
import { usePopover } from "@web/core/popover/popover_hook";
import { user } from "@web/core/user";
import { uniqueId } from "@web/core/utils/functions";
import { useBus } from "@web/core/utils/hooks";
import { hashCode } from "@web/core/utils/strings";
import {
    addFieldDependencies,
    extractFieldsFromArchInfo,
    getScheduleORMExtras,
    makeActiveField,
} from "@web/model/relational_model/utils";
import { useSubEnv } from "@web/owl2/utils";
import { useSetupAction } from "@web/search/action_hook";
import { formatInteger, formatMonetary } from "@web/views/fields/formatters";
import { OfflineActionHelper } from "@web/views/offline_action_helper";
import { AnimatedNumber } from "@web/views/view_components/animated_number";
import { crmKanbanView } from "@crm/views/crm_kanban/crm_kanban_view";
import { CrmKanbanRenderer } from "@crm/views/crm_kanban/crm_kanban_renderer";
import {
    CRM_MOBILE_ACTIVITY_LIMIT,
    CrmLeadCardCompiler,
    consumeQuickCreateDeepLink,
    crmFocusFirst,
    crmOwnEffectPromise,
    crmReturnFocusFromSheet,
    getCrmActivitySubfields,
    isFieldMapping,
    useCrmFocusKeeper,
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
 * Hotkeys the inherited kanban renderer registers on its root for its card
 * selection (Space, Shift+Space) and card navigation (arrows; ArrowUp then falls
 * back to the search bar). The hotkey service dispatches them for any control
 * inside that root and then prevents their default action, so on the mobile
 * layout, which renders no kanban card, they would only block what the focused
 * control does natively: a button's activation by Space, and the choice of an
 * option with the arrow keys on a stage selector.
 */
const KANBAN_CARD_HOTKEYS = Object.freeze(
    new Set(["space", "shift+space", "arrowup", "arrowdown", "arrowleft", "arrowright"])
);

/**
 * Event of the controller's quick-create bus (`quickCreateState.bus`, shared with
 * the renderer) asking the displayed stage pipeline to open its quick-create
 * sheet. Its detail is `{handled: false}`; a renderer that opens the sheet sets
 * `handled`.
 */
const OPEN_MOBILE_QUICK_CREATE = "CRM-MOBILE-PIPELINE:OPEN-QUICK-CREATE";

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
 * Whether the framework queue holds lead or activity calls its next replay sends:
 * queued and not parked (a parked call is only sent again from the systray).
 *
 * @param {Object} crmOffline the `useCrmOffline()` API
 * @returns {boolean}
 */
function hasCrmEntriesToReplay(crmOffline) {
    return ["crm.lead", "mail.activity"].some((model) =>
        crmOffline.queuedEntries(model).some(({ value }) => !value.extras?.error)
    );
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

/**
 * Key of the stage pipeline's place in the action's global state: the stage shown
 * and the scroll offset when the pipeline was left, so that coming back to it
 * (breadcrumbs, back button or browser history) shows them again.
 */
const PIPELINE_STATE_KEY = "crmMobilePipeline";

/**
 * Reads the stage pipeline's place exported in an action's global state.
 *
 * @param {unknown} value the exported JSON string
 * @returns {{stageId: number|false, scrollTop: number}|null} `null` when absent or
 *  malformed; `stageId` is a stage group's value (`false`: the "no stage" group)
 */
function parsePipelineState(value) {
    if (typeof value !== "string") {
        return null;
    }
    let state;
    try {
        state = JSON.parse(value);
    } catch {
        return null;
    }
    if (!state || typeof state !== "object") {
        return null;
    }
    const { stageId, scrollTop } = state;
    if (stageId !== false && !Number.isSafeInteger(stageId)) {
        return null;
    }
    return { stageId, scrollTop: Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0 };
}

/**
 * Per raw root list, the stage id of each lead (by `resId`) at its latest online
 * save. That is the stage the server's refreshed progress-bar counts count the
 * lead in: every online save of a record of the view refreshes them
 * (`onRecordSaved`). Offline saves never reach that hook, so a queued write
 * leaves the entry unchanged. The map belongs to one root: a root reload starts
 * with an empty one.
 *
 * @type {WeakMap<Object, Map<number, number|false>>}
 */
const barStagesByRoot = new WeakMap();

/**
 * The online-saved lead stages of a root list (`barStagesByRoot`), created empty
 * on first use.
 *
 * @param {Object} root root list, reactive or raw
 * @returns {Map<number, number|false>}
 */
function barStages(root) {
    const rawRoot = toRaw(root);
    let stages = barStagesByRoot.get(rawRoot);
    if (!stages) {
        stages = new Map();
        barStagesByRoot.set(rawRoot, stages);
    }
    return stages;
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
        /** Whether the last root load sends the opening info of the groups. */
        this.crmLastSentOpeningInfo = false;
        /** @type {Promise<void>|null} pending check of reloads asked for before ready */
        this.crmDeferredReload = null;
        this.crmVariants = this.crmComputeVariants();
        super.setup();
        // The place the stage pipeline was left at, for the renderer to show again.
        useSubEnv({
            crmPipelineState: parsePipelineState(this.props.globalState?.[PIPELINE_STATE_KEY]),
        });

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
                this.crmOffline.markRootLoad(this.model, config);
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
        /** Whether the fallback's online reload waits for the end of the replay. */
        let reloadAfterReplay = false;
        useEffect(() => {
            const isOffline = this.crmOffline.isOffline();
            const reconnected = wasOffline && !isOffline;
            wasOffline = isOffline;
            if (!reconnected || !this.crmDesktopFallback) {
                return;
            }
            // The fallback root, and every root loaded offline since, came from the
            // offline cache, whatever the width is now: it is reloaded online. That
            // load applies the current screen's variant and ends the fallback
            // (`crmApplyVariant`); on a wide screen it is the `crm_kanban` request.
            // There, nothing reloads after the replay this reconnection starts, and a
            // load sent before it would read none of the queued CRM writes: with
            // writes to replay, the reload waits for the end of the replay. A small
            // screen reloads now, and its renderer again once they are replayed.
            untrack(() => {
                reloadAfterReplay =
                    !this.crmOffline.isSmall && hasCrmEntriesToReplay(this.crmOffline);
                if (!reloadAfterReplay) {
                    this.crmReload();
                }
            });
        });
        this.crmOffline.onReplayed(() => {
            if (!reloadAfterReplay) {
                return;
            }
            reloadAfterReplay = false;
            // A screen turned small during the replay has reloaded on its resize, and
            // its renderer reconciles what was still queued then.
            if (!this.crmOffline.isSmall) {
                this.crmReload();
            }
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
                        this.crmOffline.markRootLoad(this.model, config);
                    }
                },
                crmUseDesktopSpec: () => this.crmUseDesktopSpec(),
                crmLoadWithoutOpeningInfo: () => this.crmLoadWithoutOpeningInfo(),
                crmLoadMoreActivities: () => this.crmLoadMoreActivities(),
            },
        };
    }

    /**
     * Model hook of each successful online save of a record of the view (the
     * parent binds it into the model's hooks). After the parent, which refreshes
     * the progress-bar counts, records a lead's saved stage in the current root's
     * `barStages`, on every form factor: a client-side map only, without request
     * or DOM change.
     *
     * @param {Object} record the saved record
     * @param {Object} changes the saved changes
     * @returns {unknown} what the parent's hook returns
     */
    onRecordSaved(record, changes) {
        const result = super.onRecordSaved(...arguments);
        if (record.resModel === "crm.lead" && record.data.stage_id !== undefined) {
            barStages(this.model.root).set(record.resId, many2oneId(record.data.stage_id));
        }
        return result;
    }

    /**
     * @override
     * The control-panel "New" (and its Alt+C hotkey). Where the framework would open
     * its inline quick create in the first column, the small-screen stage pipeline
     * has no column to render it in: the renderer opens its quick-create sheet on
     * the displayed stage instead, and the framework quick-create state stays
     * closed (no group toggled, no request). Wide screens, other groupings,
     * ungrouped lists and arches without `on_create="quick_create"` keep the
     * framework behaviour.
     */
    async createRecord() {
        if (this.canQuickCreate && this.props.archInfo.onCreate === "quick_create") {
            const request = { handled: false };
            this.quickCreateState.bus.trigger(OPEN_MOBILE_QUICK_CREATE, request);
            if (request.handled) {
                return;
            }
        }
        return super.createRecord();
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
     * search (`crmActivityScope`) per lead. Also notes whether the load sends the
     * opening info of the groups (`crmLoadWithoutOpeningInfo`).
     *
     * @param {Object} config root configuration about to be loaded
     */
    crmApplyVariant(config) {
        if (!this.crmOffline.isOffline()) {
            this.crmDesktopFallback = false;
        }
        this.crmLastSentOpeningInfo = Boolean(config.sendOpeningInfo);
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
     * `crmLoadWithoutOpeningInfo` model hook, called by `CrmKanbanModel` when a root
     * load failed with a lost connection. Returns `true` when that load sent the
     * opening info of the groups, offline on a small screen: the model then reads
     * the root once more without it, the request of the last root load made before
     * a group was loaded on its own (e.g. by "Load more"), which the cache may hold.
     * A wide screen keeps the `crm_kanban` requests.
     *
     * @returns {boolean}
     */
    crmLoadWithoutOpeningInfo() {
        return (
            this.crmOffline.isSmall && this.crmOffline.isOffline() && this.crmLastSentOpeningInfo
        );
    }

    /**
     * Owns effect-started reloads and reports non-connection errors once. Before
     * readiness, calls share a deferred check: reload only if the controller
     * survives and either the current screen requires another variant or the
     * desktop-variant fallback outlived the connection loss (its root came from
     * the offline cache). A root that could not be loaded at all offline (the
     * framework's offline helper shows instead of the view) is loaded at once when
     * the connection is back: no pending load would ever make the model ready.
     */
    crmReload() {
        if (this.model.isReady()) {
            crmOwnEffectPromise(this.model.load());
            return;
        }
        if (this.model.couldNotLoadRootOffline && !this.crmOffline.isOffline()) {
            // The search runs the view's own load again, as a search does: it makes
            // the model ready, and the view replaces the helper.
            this.env.searchModel.search();
            return;
        }
        if (!this.crmDeferredReload) {
            // `whenReady` is resolved after the first successful load, never rejected.
            this.crmDeferredReload = this.model.whenReady.promise.then(() => {
                this.crmDeferredReload = null;
                const fallbackOnline = this.crmDesktopFallback && !this.crmOffline.isOffline();
                if (
                    status(this) === "destroyed" ||
                    (this.crmLastVariant === this.crmCurrentVariant() && !fallbackOnline)
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
        /**
         * Scroll offset of the stage shown again when coming back to the pipeline,
         * applied once that stage's cards are rendered (`crmApplyPendingScroll`).
         *
         * @type {number|null}
         */
        this.crmPendingScrollTop = null;
        this.crmRestoreStage(this.env.crmPipelineState);
        useSetupAction({ getGlobalState: () => this.crmExportPipelineState() });
        this.quickCreate = usePopover(CrmMobileQuickCreate, {
            useBottomSheet: true,
            // Without an env, the overlay's env provider is attached to the web
            // client's root and never released: every closed sheet (components, DOM
            // and listeners) would stay in memory. This one is released on close.
            env: this.env,
            onClose: () => this.crmOnQuickCreateClosed(),
        });
        /** @type {HTMLElement|null} control that opened the quick create */
        this.crmQuickCreateOpener = null;
        /** @type {Set<string>} ids of the stage groups whose "Load more" is loading */
        this.crmLoadingMore = proxy(new Set());
        /** @type {{x: number, y: number}|null} start of the current touch gesture */
        this.crmTouch = null;
        this.crmMounted = false;

        // On a small screen, the CRM entries the replay sends stay shown (provisional
        // cards, header totals, sheet rows) until this pipeline displays a root
        // loaded from the server after their replay, which then shows them as
        // server records in the same render.
        this.crmReplayHold = this.crmOffline.holdReplayed(
            () => this.isMobile,
            () => this.props.list
        );

        // Reconciliation reload: ignore empty and parked-only syncs. Arm while
        // replayable CRM entries are queued on a small screen; keep armed until the
        // sync ends, or disarm when a discard leaves none. A wide screen neither
        // reads the queue nor stays armed: turning small reloads the root anyway.
        // Replayed entries still held mean their reconciliation was lost (with the
        // connection, or refused by the server): any later sync end, even an empty
        // one, reloads.
        const hasEntriesToReplay = () =>
            ["crm.lead", "mail.activity"].some((model) =>
                this.crmOffline.queuedEntries(model).some(({ value }) => !value.extras?.error)
            );
        const hasParkedEntries = () =>
            ["crm.lead", "mail.activity"].some((model) =>
                this.crmOffline.queuedEntries(model).some(({ value }) => value.extras?.error)
            );
        /**
         * Text of the pipeline's sync status region: the outcome of the last replay
         * that had CRM entries to replay. It is cleared when entries are queued
         * again, so that the next outcome is announced even when it reads the same,
         * and once a discard leaves no parked entry to report as failed.
         */
        this.crmSyncStatus = signal("");
        let hasQueuedEntries = false;
        useEffect(() => {
            if (!this.isMobile) {
                hasQueuedEntries = false;
                untrack(() => this.crmSyncStatus.set(""));
                return;
            }
            if (hasEntriesToReplay()) {
                hasQueuedEntries = true;
                untrack(() => this.crmSyncStatus.set(""));
            }
        });
        this.crmOffline.onReplayed(() => {
            if (hasQueuedEntries || this.crmReplayHold.holding()) {
                hasQueuedEntries = false;
                // Parked entries stay queued (their cards read "Sync failed").
                this.crmSyncStatus.set(
                    hasParkedEntries()
                        ? _t("Some offline changes failed to sync")
                        : _t("Offline changes synced")
                );
                return this.crmReloadIfMobile();
            }
        });
        const disarmAfterDiscard = () => {
            if (!this.isMobile || !hasEntriesToReplay()) {
                hasQueuedEntries = false;
            }
            // The discarded changes were never synced: the region is emptied, not
            // set to "synced", once no parked entry is left to report as failed.
            if (!hasParkedEntries()) {
                this.crmSyncStatus.set("");
            }
        };
        this.crmOffline.onEntriesDiscarded("crm.lead", () => {
            disarmAfterDiscard();
            return this.crmReloadAfterDiscard();
        });
        // No reload for a discarded activity: the cards show no activity, and the
        // activity sheet follows its own discards.
        this.crmOffline.onEntriesDiscarded("mail.activity", disarmAfterDiscard);

        /** Root list whose displayed stage was last checked by `crmEnsureGroupLoaded`. */
        this.crmCheckedRoot = null;
        /**
         * That root's groups (raw array) at that check. A root can get new groups
         * without being replaced: the server's answer to a root load served from
         * the cache first, when it differs from the cached one.
         *
         * @type {Object[]|null}
         */
        this.crmCheckedGroups = null;

        /**
         * Stage shown when a discard reload of the stage pipeline started
         * (`crmReloadAfterDiscard`): the raw root it reloads, and the value and index
         * of that stage; `null` once another root is given (`crmKeepShownStage`) or
         * when the reload fails.
         *
         * @type {{root: Object, value: number|false, index: number}|null}
         */
        this.crmDiscardShownStage = null;
        onWillUpdateProps(({ list }) => this.crmKeepShownStage(list));

        /** Stage choices of the ungrouped list, in server order (`crmLoadStageChoices`). */
        this.crmStageChoices = signal([]);
        /**
         * Their loads: `request`, the last one started (`{key}`, its search), `null`
         * to load again; `online`, the choices are stages the server listed while
         * this pipeline is mounted; `offline`, the last load read none from it.
         */
        this.crmStageChoicesLoad = { request: null, online: false, offline: false };

        onMounted(() => {
            this.crmMounted = true;
            this.crmMaybeWarm();
            this.crmMaybeLoadStageChoices();
            // The "New Lead" shortcut flag belongs to its launch: the first pipeline
            // mount takes it, whatever its layout or grouping. Only the small-screen
            // stage pipeline opens the sheet; a wide screen keeps the unchanged
            // desktop kanban and leaves nothing for a later phone pipeline.
            const deepLink = consumeQuickCreateDeepLink();
            if (this.isStagePipeline) {
                this.crmMarkStageChecked();
                crmOwnEffectPromise(this.crmEnsureGroupLoaded(this.activeGroup));
                this.crmApplyPendingScroll();
                if (deepLink && this.canQuickCreate()) {
                    this.openQuickCreate();
                }
            } else {
                // A scroll offset belongs to the stage pipeline it was exported by.
                this.crmPendingScrollTop = null;
            }
        });
        // The offset of a stage shown again before its leads were loaded is applied
        // at the patch rendering them.
        onPatched(() => this.crmApplyPendingScroll());

        // A root reload (search, reconciliation, or the variant reload when the
        // screen turns small) brings new groups, folded as the server returns them,
        // and so does the server's answer to a root load first served from the
        // cache (coming back to the pipeline): the displayed stage of each new set
        // of groups is loaded. An ungrouped list loads the stage choices of a new
        // search.
        // New groups of the same root replace the cards of a displayed stage the
        // server folds with none: its scroll offset is kept until they are shown
        // again (`crmApplyPendingScroll`), as for a stage shown again.
        onWillPatch(() => {
            if (
                this.crmPendingScrollTop !== null ||
                !this.isStagePipeline ||
                this.props.list !== this.crmCheckedRoot ||
                !this.crmHasNewGroups() ||
                !this.crmIsStageLoading(this.activeGroup)
            ) {
                return;
            }
            const scrollTop = this.crmScroller()?.scrollTop || 0;
            if (scrollTop > 0) {
                this.crmPendingScrollTop = scrollTop;
            }
        });
        onPatched(() => {
            if (this.isStagePipeline && this.crmHasNewGroups()) {
                this.crmMarkStageChecked();
                crmOwnEffectPromise(this.crmEnsureGroupLoaded(this.activeGroup));
            }
            this.crmMaybeLoadStageChoices();
        });

        // Stage choices the server did not list (read offline, or when the
        // connection dropped) are loaded again once the connection is back.
        let stageChoicesWasOffline = this.crmOffline.isOffline();
        useEffect(() => {
            const isOffline = this.crmOffline.isOffline();
            const reconnected = stageChoicesWasOffline && !isOffline;
            stageChoicesWasOffline = isOffline;
            if (reconnected && this.crmStageChoicesLoad.offline) {
                untrack(() => {
                    this.crmStageChoicesLoad.request = null;
                    this.crmMaybeLoadStageChoices();
                });
            }
        });

        this.crmHelperBackRef = signal.ref();
        /** End marker after the displayed cards, focused by the skip link. */
        this.crmEndRef = signal.ref();
        this.crmLeadHelperId = uniqueId("o_crm_mobile_pipeline_lead_helper_");
        /**
         * Focus target for the next patch: helper Back, the reopened lead card, or
         * a control that remains after a card stage move (`crmMoveWithFocus`).
         *
         * @type {{helperLeadId: number}|{leadId: number}|{movedLeadId: number,
         *  index: number, cardEl: HTMLElement, stageId: number|false|undefined,
         *  settled: boolean}|null}
         */
        this.crmFocusRequest = null;
        onPatched(() => this.crmApplyFocusRequest());
        // A control that disables itself (stage navigation at a bound, "Load more"
        // once loaded) or leaves with its card hands the focus on. The focus a card
        // stage move takes along is the move's own (`crmFocusRequest`), which the
        // keeper leaves alone. While "Load more" loads, the stage name holds the
        // focus.
        useCrmFocusKeeper(this.rootRef, {
            describe: (el, root) => this.crmDescribeFocus(el, root),
            candidates: (lost, root) => this.crmFocusCandidates(lost, root),
            park: (lost, root) =>
                root.querySelector(
                    ".o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_stage_name"
                ),
        });

        let wasMobile = this.isMobile;
        let wasOffline = this.crmOffline.isOffline();
        useEffect(() => {
            const isMobile = this.isMobile;
            const isOffline = this.crmOffline.isOffline();
            const turnedMobile = isMobile && !wasMobile;
            const turnedDesktop = !isMobile && wasMobile;
            const reconnected = wasOffline && !isOffline;
            wasMobile = isMobile;
            wasOffline = isOffline;
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
                // Loading a stage of the current root would race that reload, which
                // replaces the root and its groups.
                untrack(() => this.crmMarkStageChecked());
            } else if (reconnected && isMobile) {
                // A stage reached offline issued no request: the one displayed when
                // the connection returns is loaded now.
                untrack(() => {
                    if (this.isStagePipeline) {
                        crmOwnEffectPromise(this.crmEnsureGroupLoaded(this.activeGroup));
                    }
                });
            }
        });

        const { quickCreateState } = this.props;
        if (quickCreateState) {
            // The controller's `createRecord` (control-panel "New", Alt+C) asks the
            // displayed stage pipeline for its sheet; elsewhere the request is left
            // unhandled and the framework quick create opens. The control that asked
            // is the focused one (a tap or the hotkey focuses the button): closing
            // the sheet gives the focus back to it.
            useBus(quickCreateState.bus, OPEN_MOBILE_QUICK_CREATE, (ev) => {
                if (this.isStagePipelineShown) {
                    ev.detail.handled = true;
                    const focused = document.activeElement;
                    const opener =
                        focused && focused !== document.body && !focused.closest(".o_bottom_sheet")
                            ? focused
                            : undefined;
                    this.openQuickCreate(opener);
                }
            });
            // The displayed stage pipeline renders no framework quick create, so its
            // state never stays open there: e.g. an inline quick create left open on
            // a wide screen that turned small, whose column is gone and whose group
            // the variant reload replaces. Closing it opens no sheet.
            useEffect(() => {
                if (quickCreateState.isOpen && this.isStagePipelineShown) {
                    untrack(() => quickCreateState.closeQuickCreate());
                }
            });
        }
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

    /**
     * Whether the template renders the small-screen stage pipeline (its stage
     * header and body) rather than the framework kanban: a stage pipeline with a
     * stage to display.
     */
    get isStagePipelineShown() {
        return this.isStagePipeline && Boolean(this.activeGroup);
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
        if (groups.some((group) => this.crmStagePendingCreates(group, groups).length)) {
            return false;
        }
        const stageIds = this.crmStageIds(groups);
        return !this.crmLoadedLeads().some(({ record, group }) =>
            stageIds.has(this.crmProjectedStage(record, group, stageIds))
        );
    }

    /**
     * Stage choices of the cards and the quick create, `{id, display_name}`: the
     * stage groups (without the "no stage" group) on the stage pipeline. Otherwise
     * the stages the list shows when grouped by stage (`crmStageChoices`, in
     * server order), followed by the other stages of the loaded records, so that
     * a lead's own stage is offered, also before those choices are loaded.
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
        for (const stage of this.crmStageChoices()) {
            stages.set(stage.id, stage);
        }
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
     * Mobile-only load of the ungrouped list's stage choices, when mounted, once
     * per search (domain and context), and again at an online discard reload
     * (`crmReloadAfterDiscard`): a wide screen and a grouped list issue no
     * request. Errors other than a lost connection are reported once.
     */
    crmMaybeLoadStageChoices() {
        const { list } = this.props;
        if (!this.crmMounted || !this.isMobile || list.isGrouped) {
            return;
        }
        const key = JSON.stringify([list.domain, list.context]);
        if (this.crmStageChoicesLoad.request?.key === key) {
            return;
        }
        const request = { key };
        this.crmStageChoicesLoad.request = request;
        crmOwnEffectPromise(this.crmLoadStageChoices(list, request));
    }

    /**
     * Stage choices of `list` (`loadStageChoices`): the server's online, the
     * cached ones offline with no request. Offline, stages the server listed while
     * this pipeline is mounted are kept rather than the cached ones, which have no
     * server order. A load other than the last one started changes nothing. A
     * cached load that ends online starts the load again.
     *
     * @param {Object} list the ungrouped root list
     * @param {{key: string}} request
     * @returns {Promise<void>}
     */
    async crmLoadStageChoices(list, request) {
        const load = this.crmStageChoicesLoad;
        if (this.crmOffline.isOffline() && load.online) {
            load.offline = true;
            return;
        }
        const { stages, cached } = await this.crmOffline.loadStageChoices(list);
        if (request !== load.request) {
            return;
        }
        load.offline = cached;
        if (!cached || !load.online) {
            load.online = !cached;
            this.crmStageChoices.set(stages);
        }
        // Back online after a cached load: the connection returned while this load
        // ran, before `offline` was set, so the reconnection effect read nothing
        // again. A destroyed pipeline starts no load.
        if (cached && !this.crmOffline.isOffline() && status(this) === "mounted") {
            load.request = null;
            this.crmMaybeLoadStageChoices();
        }
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
     * Reconciliation reload after a discard (`crmReloadIfMobile`). Online, on a
     * small screen, the reloaded root lists the stages the server lists, so that a
     * stage deleted on the server since leaves the stage navigation, the card stage
     * selectors and the quick create (`stages`):
     * - the stage pipeline's load drops the groups the framework would list again,
     *   emptied, on a reload of the same search (`crmServerGroups`, see
     *   `CrmKanbanModel._getNextConfig`), and the stage shown stays shown
     *   (`crmKeepShownStage`);
     * - an ungrouped list reads its stage choices again, alongside its root.
     * A list grouped by another field reloads as the framework reloads it. Offline,
     * the root is served from the cache as the framework serves it, its stages
     * included.
     *
     * @returns {Promise<void>|undefined}
     */
    crmReloadAfterDiscard() {
        const { list } = this.props;
        if (
            !this.isMobile ||
            this.crmOffline.isOffline() ||
            (list.isGrouped && !this.isStagePipeline)
        ) {
            return this.crmReloadIfMobile();
        }
        if (!list.isGrouped) {
            this.crmStageChoicesLoad.request = null;
            this.crmMaybeLoadStageChoices();
            return this.crmReloadIfMobile();
        }
        const group = this.activeGroup;
        const shown = group
            ? { root: toRaw(list), value: group.value, index: this.activeIndex }
            : null;
        this.crmDiscardShownStage = shown;
        return list.model.load({ crmServerGroups: true }).catch((error) => {
            if (this.crmDiscardShownStage === shown) {
                this.crmDiscardShownStage = null;
            }
            ignoreConnectionLost(error);
        });
    }

    /**
     * Keeps the stage shown across a discard reload of the stage pipeline
     * (`crmDiscardShownStage`) when the renderer is given the first root after the
     * reload started (the reload's own, or that of a load superseding it), before
     * it renders it: the stage stays shown when stages before it are no longer
     * listed. When it is no longer listed itself, the stage now at its place (the
     * last one when it was the last) is shown, from its first card, as a stage
     * change shows it (`crmShowStage`). The roots of other loads keep the index.
     *
     * @param {Object} list the root list the renderer is given
     */
    crmKeepShownStage(list) {
        const shown = this.crmDiscardShownStage;
        if (!shown || toRaw(list) === shown.root) {
            return;
        }
        this.crmDiscardShownStage = null;
        if (!list.isGrouped || list.groupByField?.name !== "stage_id") {
            return;
        }
        // The display order of the kanban renderer (`getGroupsOrRecords`): the group
        // without stage first, then the others in server order.
        const values = [
            ...list.groups.filter((group) => !group.value),
            ...list.groups.filter((group) => group.value),
        ].map((group) => group.value);
        const index = values.indexOf(shown.value);
        if (index >= 0) {
            this.mobile.activeIndex = index;
            return;
        }
        this.crmPendingScrollTop = null;
        const scroller = this.crmScroller();
        if (scroller) {
            scroller.scrollTop = 0;
        }
        this.mobile.activeIndex = Math.max(Math.min(shown.index, values.length - 1), 0);
    }

    /**
     * Loads the leads of a displayed stage that holds none of its `count` leads,
     * folded or not: a folded stage reached for the first time, or a stage reached
     * while offline and displayed again online. Online, one request loads them
     * into the stage's own list, and calls made while it runs share it; the stage
     * keeps the fold state the server gave it. Offline, nothing is done and no
     * request is issued: the stage shows the offline helper. A stage whose leads
     * were loaded keeps its cards, folded or not. Only a lost connection is
     * swallowed.
     *
     * @param {Object|null} group
     * @returns {Promise<void>|undefined}
     */
    crmEnsureGroupLoaded(group) {
        if (
            !group ||
            this.crmOffline.isOffline() ||
            !(group.count > 0) ||
            group.list.records.length
        ) {
            return;
        }
        // Not `toggleGroup`: `Group.toggle` flips the group's fold state and makes
        // the root send the opening info of every group. The next root request
        // would then differ from the one the RPC cache serves offline, and the
        // stage, folded on the server, would render unfolded on a wide screen.
        return group.list
            .crmLoadMissingRecords()
            .then(() => group._useGroupCountForList())
            .catch(ignoreConnectionLost);
    }

    // -------------------------------------------------------------------------
    // Navigation
    // -------------------------------------------------------------------------

    /**
     * The element scrolling the stage pipeline: the view's content area, which a
     * grouped kanban scrolls itself on a small screen (`o_action_delegate_scroll`).
     *
     * @returns {HTMLElement|null} `null` while the pipeline is not rendered
     */
    crmScroller() {
        return this.rootRef()?.closest(".o_content") || null;
    }

    /**
     * Shows again the stage the pipeline was left on (`parsePipelineState`) when
     * the list is grouped by stage and still has that stage; otherwise the first
     * stage stays shown. Its scroll offset waits for `crmApplyPendingScroll`.
     *
     * @param {{stageId: number|false, scrollTop: number}|null} [state]
     */
    crmRestoreStage(state) {
        const { list } = this.props;
        if (!state || !list.isGrouped || list.groupByField?.name !== "stage_id") {
            return;
        }
        const index = this.stageGroups.findIndex((group) => group.value === state.stageId);
        if (index < 0) {
            return;
        }
        this.mobile.activeIndex = index;
        this.crmPendingScrollTop = state.scrollTop || null;
    }

    /**
     * Whether a stage the server folds holds none of its leads yet: its cards are
     * shown once `crmEnsureGroupLoaded` (online) has loaded them.
     *
     * @param {Object|null} group
     * @returns {boolean}
     */
    crmIsStageLoading(group) {
        return Boolean(group?.isFolded && group.count > 0 && !group.list.records.length);
    }

    /**
     * Notes the current root and its groups as those whose displayed stage
     * `crmEnsureGroupLoaded` was asked to load.
     */
    crmMarkStageChecked() {
        const { list } = this.props;
        this.crmCheckedRoot = list;
        this.crmCheckedGroups = toRaw(list.groups) || null;
    }

    /**
     * Whether the root, or its groups, are not those last noted by
     * `crmMarkStageChecked`.
     *
     * @returns {boolean}
     */
    crmHasNewGroups() {
        const { list } = this.props;
        return (
            list !== this.crmCheckedRoot || (toRaw(list.groups) || null) !== this.crmCheckedGroups
        );
    }

    /**
     * Applies, once, the scroll offset of the stage shown again: on the stage
     * pipeline only, and only when that stage's cards are rendered. A stage whose
     * leads were never loaded (the load `crmEnsureGroupLoaded` starts) keeps it
     * until a patch shows them.
     */
    crmApplyPendingScroll() {
        const scrollTop = this.crmPendingScrollTop;
        if (scrollTop === null) {
            return;
        }
        const group = this.activeGroup;
        if (!this.isStagePipeline || !group) {
            this.crmPendingScrollTop = null;
            return;
        }
        if (this.crmIsStageLoading(group)) {
            return;
        }
        this.crmPendingScrollTop = null;
        const scroller = this.crmScroller();
        if (scroller) {
            scroller.scrollTop = scrollTop;
        }
    }

    /**
     * `getGlobalState` of the action: the stage shown and the scroll offset of the
     * stage pipeline (an offset still to be applied counts as the current one), as
     * a JSON string under `PIPELINE_STATE_KEY`. A wide screen, or a list not
     * grouped by stage, exports nothing: its global state stays the kanban's.
     *
     * @returns {Object}
     */
    crmExportPipelineState() {
        const group = this.isStagePipeline ? this.activeGroup : null;
        if (!group) {
            return {};
        }
        const scrollTop = this.crmPendingScrollTop ?? (this.crmScroller()?.scrollTop || 0);
        return {
            [PIPELINE_STATE_KEY]: JSON.stringify({ stageId: group.value, scrollTop }),
        };
    }

    /**
     * Shows the stage at `index` (a valid index of `stageGroups`). Every stage uses
     * the same scrolling element, so another stage than the one shown opens at its
     * first card, and the scroll offset still to be restored is dropped. Showing
     * the stage already shown changes nothing.
     *
     * @param {number} index
     */
    crmShowStage(index) {
        if (index !== this.activeIndex) {
            this.crmPendingScrollTop = null;
            const scroller = this.crmScroller();
            if (scroller) {
                scroller.scrollTop = 0;
            }
        }
        this.mobile.activeIndex = index;
    }

    async goToStage(index) {
        const count = this.stageGroups.length;
        if (!count) {
            return;
        }
        this.crmShowStage(Math.min(Math.max(index, 0), count - 1));
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

    /**
     * Keydown on the mobile layout: the inherited kanban card hotkeys
     * (`KANBAN_CARD_HOTKEYS`) stop here, before the window-level hotkey service,
     * so the focused control keeps its native behaviour: Space activates a
     * button, the arrow keys choose a stage selector's option. The default action
     * is never prevented, and every other key, Enter, Escape and the modifier
     * combinations of the other hotkeys included, goes on to the hotkey service.
     * The wide-screen kanban does not render this layout and keeps its card
     * hotkeys.
     *
     * @param {KeyboardEvent} ev
     */
    onMobileKeydown(ev) {
        if (KANBAN_CARD_HOTKEYS.has(getActiveHotkey(ev))) {
            ev.stopPropagation();
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
     * @param {Set<number|false>} [stageIds] the stage groups' values (`crmStageIds`),
     *  as for `crmStageOf`
     * @returns {number|false|null} the stage id (`false`: no stage), or `null` while
     *  a pending delete or archive hides the lead
     */
    crmProjectedStage(record, group, stageIds) {
        return this.crmStageOf(this.crmOffline.projectLead(record), group, stageIds);
    }

    /**
     * The stage a lead projection is displayed in (rules of `crmProjectedStage`),
     * for a projection already computed.
     *
     * With `group` and `stageIds`, a projected stage that no stage group shows is
     * displayed in `group`: a queued move to a stage the displayed root has no
     * group for, such as one deleted on the server since, whose replay parks the
     * move. The lead then keeps its card, count and revenue in the stage that holds
     * it, with its pending or failed sync badge, instead of being shown nowhere.
     * Without `stageIds`, the projected stage itself is returned (a stage move
     * compares the choice with it).
     *
     * @param {Object|null} projection `projectLead` of the lead's record
     * @param {Object} [group] the group whose list holds the record
     * @param {Set<number|false>} [stageIds] the stage groups' values (`crmStageIds`)
     * @returns {number|false|null} the stage id (`false`: no stage), or `null` while
     *  a pending delete or archive hides the lead
     */
    crmStageOf(projection, group, stageIds) {
        if (!projection) {
            return null;
        }
        if (projection.stage_id === undefined) {
            // Stage not loaded (offline desktop-variant fallback): the group's.
            return group ? group.value : false;
        }
        const stageId = many2oneId(projection.stage_id);
        if (group && stageIds && !stageIds.has(stageId)) {
            return group.value;
        }
        return stageId;
    }

    /**
     * Values of the stage groups (`stageGroups`), the stages a lead or a lead
     * created offline can be displayed in.
     *
     * @param {Object[]} [groups] `stageGroups` already read
     * @returns {Set<number|false>}
     */
    crmStageIds(groups = this.stageGroups) {
        return new Set(groups.map((group) => group.value));
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
     * displayed in (`crmStageOf`, a stage no group shows displayed in the group
     * holding the lead). Computed on each call, never stored.
     *
     * @returns {{record: Object, group: Object, projection: Object|null, stageId: number|false|null}[]}
     */
    crmProjectedLeads() {
        const stageIds = this.crmStageIds();
        return this.crmLoadedLeads().map(({ record, group }) => {
            const projection = this.crmOffline.projectLead(record);
            return {
                record,
                group,
                projection,
                stageId: this.crmStageOf(projection, group, stageIds),
            };
        });
    }

    /**
     * Leads created offline displayed in a stage, as provisional card data: the
     * stage's own (`pendingCreates`), then, in the first stage group, those created
     * in a stage no stage group shows (`pendingCreatesOutside`), such as one deleted
     * on the server since, whose replay parks the create. Every create the queue
     * holds thus keeps a card, counted in the header of the stage showing it.
     *
     * @param {Object} group
     * @param {Object[]} [groups] `stageGroups` already read
     * @returns {Object[]}
     */
    crmStagePendingCreates(group, groups = this.stageGroups) {
        const pending = this.crmOffline.pendingCreates(group.value);
        if (!groups.length || group.id !== groups[0].id) {
            return pending;
        }
        const outside = this.crmOffline.pendingCreatesOutside(this.crmStageIds(groups));
        return outside.length ? [...pending, ...outside] : pending;
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
     * }} `records` as `getStageRecords`, `pending` as `crmStagePendingCreates`,
     *  `count` as `getStageCount`, `revenue` as `getStageRevenue`
     */
    crmStageView(group) {
        const leads = this.crmProjectedLeads();
        const pending = this.crmStagePendingCreates(group);
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
     * Count of the progress-bar filter active on a stage, a legitimate `0`
     * included: `getGroupCount` once the bar counts are loaded, else the active
     * bar's latest server count. A root load offline is served from the cache
     * without its bar counts (`read_progress_bar` is not cached), while the bar
     * keeps filtering the stage's leads. `undefined` when no bar filters the stage.
     *
     * @param {Object} group
     * @returns {number|undefined}
     */
    crmGetBarCount(group) {
        const { progressBarState } = this.props;
        if (!progressBarState) {
            return undefined;
        }
        return (
            progressBarState.getGroupCount(group) ??
            progressBarState.activeBars?.[group.serverValue]?.count
        );
    }

    /**
     * Lead count of a stage header: a base, plus the leads created offline it shows
     * (`crmStagePendingCreates`), minus the loaded leads the base counts in it that
     * are hidden or projected elsewhere, plus the loaded leads it does not count
     * there projected into it. Never below 0.
     *
     * - Without an active progress-bar filter, the base is `group.count`, which the
     *   framework's moves adjust: a loaded lead counts in the group holding it.
     * - With one, the base is the active bar's count (`crmGetBarCount`; a filtered
     *   `0` stays `0`).
     *   The server computes it at the root load and again after each online save,
     *   and nothing adjusts it for a queued write. So a loaded lead counts in the
     *   stage it had when those counts were last computed: its stage at its latest
     *   online save (`barStages`), else its server stage in the displayed root's
     *   snapshot, else the stage of the group holding it. A lead whose stage is
     *   not loaded (offline desktop-variant fallback of an arch without it) has no
     *   server stage in the snapshot, and counts in the group holding it.
     *
     * @param {Object} group
     * @param {Object[]} [leads] `crmProjectedLeads()` already computed for this render
     * @param {Object[]} [pending] `crmStagePendingCreates(group)` already read for this render
     * @returns {number}
     */
    getStageCount(group, leads, pending) {
        const barCount = this.crmGetBarCount(group);
        let count = barCount ?? group.count;
        count += (pending ?? this.crmStagePendingCreates(group)).length;
        const { list } = this.props;
        const savedStages = barCount === undefined ? null : barStages(list);
        // The snapshot of the displayed root, as for the revenue (`getStageRevenue`).
        const serverValues = list._crmServerValues instanceof Map ? list._crmServerValues : null;
        for (const { record, group: holder, stageId } of leads ?? this.crmProjectedLeads()) {
            let counted = holder === group;
            if (savedStages) {
                const server =
                    record.data.stage_id === undefined
                        ? undefined
                        : serverValues?.get(record.resId);
                const reference = savedStages.get(record.resId) ?? server?.stageId ?? holder.value;
                counted = reference === group.value;
            }
            if (counted && stageId !== group.value) {
                count--;
            } else if (!counted && stageId === group.value) {
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
     * - plus the revenue of the leads created offline the stage shows
     *   (`crmStagePendingCreates`).
     *
     * `null` while a progress-bar filter is active (the aggregates are unfiltered)
     * or when the root load aggregated no revenue (offline desktop-variant fallback
     * of an arch without it).
     *
     * @param {Object} group
     * @param {Object[]} [leads] `crmProjectedLeads()` already computed for this render
     * @param {Object[]} [pending] `crmStagePendingCreates(group)` already read for this render
     * @returns {{value: number, currencies: number[]|undefined}|null}
     */
    getStageRevenue(group, leads, pending) {
        if (this.crmGetBarCount(group) !== undefined) {
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
        for (const create of pending ?? this.crmStagePendingCreates(group)) {
            value += amount(create.expected_revenue);
        }
        return { value, currencies: this.crmStageCurrencies(group) };
    }

    /**
     * Currencies of a stage revenue:
     * - on an arch with a progress-bar sum field, the ones the desktop column header
     *   uses (`getAggregateValue`); while those are absent (a stage without leads, or
     *   not loaded offline), the currency the loaded leads share; when no lead is
     *   loaded at all (e.g. a search matching none), the active company's currency,
     *   the one a lead's `company_currency` falls back to and so the one a 0 sum
     *   carries;
     * - on an arch without sum field, only the currency the loaded leads share.
     *
     * `undefined` when the loaded leads have several currencies, or when none applies.
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
        if (sumField && currencyIds.size === 0) {
            const companyCurrencyId = user.activeCompany?.currency_id;
            return companyCurrencyId ? [companyCurrencyId] : undefined;
        }
        return currencyIds.size === 1 ? [...currencyIds] : undefined;
    }

    /**
     * Announces the final stage count/revenue through the status region, not
     * intermediate animated values. Nothing is announced on the sample data of an
     * empty pipeline: its count and revenue are not real.
     *
     * @param {{count: number, revenue: {value: number, currencies: number[]|undefined}|null}} stageView
     *  `crmStageView(group)` of this render
     * @returns {string}
     */
    crmStageStatus({ count, revenue }) {
        if (this.props.list.model.useSampleModel) {
            return "";
        }
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
     * Whether the offline helper explains a stage's leads: offline, the stage counts
     * leads (the active progress-bar count, or the group count), none is loaded, and
     * none ever was for the displayed root, whose snapshot holds no lead with this
     * server stage. A stage whose loaded leads all moved out is empty, not uncached.
     * Without a snapshot, a stage with no loaded lead is taken as never loaded.
     *
     * @param {Object} group
     * @returns {boolean}
     */
    isStageUnavailableOffline(group) {
        if (!this.crmOffline.isOffline() || group.list.records.length) {
            return false;
        }
        const count = this.crmGetBarCount(group) ?? group.count;
        if (!(count > 0)) {
            return false;
        }
        const serverValues = this.props.list._crmServerValues;
        if (!(serverValues instanceof Map)) {
            return true;
        }
        for (const { stageId } of serverValues.values()) {
            if (stageId === group.value) {
                return false;
            }
        }
        return true;
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
        const count = this.crmGetBarCount(group) ?? group.count;
        const loaded = group.list.records.filter((record) => !record.isInQuickCreation);
        return count - loaded.length;
    }

    showLoadMore(unloadedCount) {
        return !this.crmOffline.isOffline() && unloadedCount > 0;
    }

    /**
     * The displayed stage says that it has no leads: its header counts none, so a
     * stage whose leads are still loading never shows it, and it has no card,
     * loaded or provisional. Never on sample data, nor while the empty-data helper
     * of the whole pipeline explains the empty result (e.g. of a search).
     *
     * @param {{records: Object[], pending: Object[], count: number}} stageView
     *  `crmStageView(group)` of this render
     * @returns {boolean}
     */
    crmIsStageEmpty({ records, pending, count }) {
        return (
            count === 0 &&
            !records.length &&
            !pending.length &&
            !this.props.list.model.useSampleModel &&
            !this.showNoContentHelper
        );
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
     * Skip link of the displayed cards (three tab stops each): focuses the end
     * marker that follows the last card, which brings it into view. The marker is
     * out of the tab order, so the next Tab reaches "Load more" (or whatever
     * follows the list) and Shift+Tab the last card's last control. Does nothing
     * when no card, hence no marker, is displayed.
     */
    crmSkipToEnd() {
        this.crmEndRef()?.focus();
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
        } else if ("movedLeadId" in request) {
            if (this.crmLeadOpenButton(request.movedLeadId)) {
                // The card is still shown: the move is not displayed yet (kept for
                // a later patch), or it left the card here (dropped).
                if (!request.settled) {
                    this.crmFocusRequest = request;
                }
                return;
            }
            // Only a focus lost with the card is moved, never one the user moved on,
            // and only in the stage the card was moved from (navigating away drops
            // the request): the stage header's last resort is its name.
            const active = document.activeElement;
            if (
                (!active || active === document.body) &&
                request.stageId === this.activeGroup?.value
            ) {
                crmFocusFirst([
                    this.crmMoveFocusTarget(request.index),
                    ...this.crmHeaderFocusTargets(),
                ]);
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
     * Runs a lead's stage move from its card. The move usually takes the card out
     * of the displayed stage, and with it the focus, which would fall to the body:
     * when the focus is on that card (or between two controls, as when leaving the
     * selector saves a keyboard choice), the first patch that no longer shows the
     * card focuses a control that remains (`crmMoveFocusTarget`), unless the focus
     * went elsewhere or another stage is shown meanwhile. A move that leaves the
     * card shown ends the request. This covers the card stage move only, not the
     * other pipeline actions; the focus keeper leaves the moved card's focus to it
     * (`crmDescribeFocus`).
     *
     * @param {Object} record
     * @param {() => Promise|undefined} move
     * @returns {Promise|undefined} the result of `move`, or with a focus request a
     *  promise settled as that result, once the request is ended
     */
    crmMoveWithFocus(record, move) {
        const openButton = this.crmLeadOpenButton(record.resId);
        const cardEl = openButton?.closest(".o_crm_mobile_lead_card");
        const active = document.activeElement;
        let request = null;
        if (cardEl && (!active || active === document.body || cardEl.contains(active))) {
            const cards = [
                ...this.rootRef().querySelectorAll(
                    ".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card"
                ),
            ];
            request = {
                movedLeadId: record.resId,
                index: cards.indexOf(cardEl),
                cardEl,
                stageId: this.activeGroup?.value,
                settled: false,
            };
            this.crmFocusRequest = request;
        }
        const result = move();
        if (!request) {
            return result;
        }
        const settle = () => {
            if (this.crmFocusRequest !== request) {
                return;
            }
            request.settled = true;
            if (this.crmLeadOpenButton(record.resId)) {
                this.crmFocusRequest = null;
            }
        };
        // The request ends however the move ends, and the returned promise then
        // settles as the move did: a failed move stays the caller's error, reported
        // by the framework's error handling unless the caller handles it.
        return Promise.resolve(result).finally(settle);
    }

    /**
     * The control focused after a card stage move removed the card at `index` of
     * the displayed cards: the stage selector of the card now at that index, else
     * of the card before it, else the first enabled of the header's "New", next
     * and previous controls. `null` when none remains.
     *
     * @param {number} index
     * @returns {HTMLElement|null}
     */
    crmMoveFocusTarget(index) {
        const root = this.rootRef();
        if (!root) {
            return null;
        }
        const cards = root.querySelectorAll(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card");
        for (const cardEl of [cards[index], cards[index - 1]]) {
            const select = cardEl?.querySelector(".o_crm_mobile_lead_stage:not(:disabled)");
            if (select) {
                return select;
            }
        }
        for (const control of ["new", "next", "prev"]) {
            const button = root.querySelector(
                `.o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_${control}:not(:disabled)`
            );
            if (button) {
                return button;
            }
        }
        return null;
    }

    /**
     * What the focus keeper remembers of the focused control before a patch:
     * the other navigation button for a stage navigation button, the position of
     * the card holding it, or for "Load more" the position of the first card it
     * loads. `null` outside the mobile layout, whose focus is never moved, and
     * inside the card of a pending stage move, whose request moves it on
     * (`crmMoveWithFocus`).
     *
     * @param {HTMLElement} el
     * @param {HTMLElement} root
     * @returns {{otherNav?: string, cardIndex?: number}|null}
     */
    crmDescribeFocus(el, root) {
        if (!root.classList.contains("o_crm_mobile_pipeline")) {
            return null;
        }
        if (el.matches(".o_crm_mobile_pipeline_prev")) {
            return { otherNav: ".o_crm_mobile_pipeline_next" };
        }
        if (el.matches(".o_crm_mobile_pipeline_next")) {
            return { otherNav: ".o_crm_mobile_pipeline_prev" };
        }
        const cards = [
            ...root.querySelectorAll(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card"),
        ];
        const card = el.closest(".o_crm_mobile_lead_card");
        if (card) {
            if (card === this.crmFocusRequest?.cardEl) {
                return null;
            }
            return { cardIndex: cards.indexOf(card) };
        }
        if (el.closest(".o_crm_mobile_pipeline_load_more")) {
            return { cardIndex: cards.length };
        }
        return {};
    }

    /**
     * Where the focus goes when a patch disabled or removed the focused control:
     * - from a stage navigation button: the other one, then the stage header;
     * - from a card: the card now at its position, the cards after it, then the
     *   cards before it (nearest first), then the stage header;
     * - otherwise: the stage header ("New", the navigation, the stage name).
     *
     * @param {import("@crm/mobile/crm_offline_hooks").CrmLostFocus} lost
     * @param {HTMLElement} root
     * @returns {(HTMLElement|null)[]}
     */
    crmFocusCandidates({ info }, root) {
        const header = this.crmHeaderFocusTargets();
        if (info.otherNav) {
            return [
                root.querySelector(`.o_crm_mobile_pipeline_header ${info.otherNav}`),
                ...header,
            ];
        }
        if (info.cardIndex >= 0) {
            const openButtons = [
                ...root.querySelectorAll(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_open"),
            ];
            const index = info.cardIndex;
            return [
                ...openButtons.slice(index),
                ...openButtons.slice(0, index).reverse(),
                ...header,
            ];
        }
        return header;
    }

    /**
     * Moves a lead to a stage. On the stage pipeline this is the framework's move
     * (queued offline, the CRM model skips its rainbowman lookup); on an ungrouped
     * list the record saves its new stage. A stage id that is not a positive
     * integer of an offered stage (`stages`) is ignored: nothing changes, and
     * nothing is saved or queued. A move that is neither saved nor queued leaves
     * the lead in its stage (`crmSaveStage`), and its save error, if any, rejects
     * the returned promise.
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
                return this.crmMoveWithFocus(record, () =>
                    this.crmSaveStage(record, stageValue, () =>
                        this.props.list.moveRecord(record.id, source.id, null, target.id)
                    )
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
            return this.crmMoveWithFocus(record, () => this.crmWriteStage(record, stageValue));
        }
        return this.crmMoveWithFocus(record, () =>
            this.crmSaveStage(record, stageValue, () =>
                record.update({ stage_id: stageValue }, { save: true })
            )
        );
    }

    /**
     * Saves a stage choice through `save` and keeps it last in replay order. If
     * another queued stage write ties or follows the framework save's reused
     * timestamp, appends an explicit `crmWriteStage`; unchanged or already-last
     * choices add nothing.
     *
     * A choice that is neither saved nor queued is undone: the framework reverts
     * only the record's group, while the record keeps the unsaved stage the
     * cards, counts and revenue are placed by. So when `save` throws (a rejected
     * or deleted lead, or a queue refused outside a secure context) or resolves
     * with the record still dirty (an invalid record), the record's pending
     * changes are discarded, which restores its loaded stage. A thrown error is
     * then rethrown unchanged, for the framework's own error handling.
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
        let result;
        try {
            result = await save();
        } catch (error) {
            // A save that succeeded before a later step failed (the rainbowman
            // lookup, the source group's reload) left a clean record: nothing to undo.
            if (record.dirty) {
                await record.discard();
            }
            throw error;
        }
        if (record.dirty) {
            await record.discard();
            return result;
        }
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
     * offline systray reads with `changes` for an edit). Online, during a replay
     * that has still to send queued stage writes of the lead, the write is sent
     * after them (`crmWriteInTurn`, as a card's save is); its time stamp is then
     * read when it is sent.
     *
     * @param {Object} record
     * @param {{id: number, display_name: string}} stageValue
     */
    async crmWriteStage(record, stageValue) {
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
        const result = await record.model.crmWriteInTurn(record, ["stage_id"], () => {
            const extras = getScheduleORMExtras(record.model, [record]);
            // Replay follows `extras.timeStamp`: after the writes it overrides, even
            // when the clock has not moved since they were queued.
            for (const { value } of this.crmOffline.queuedEntries("crm.lead")) {
                extras.timeStamp = Math.max(extras.timeStamp, (value.extras?.timeStamp || 0) + 1);
            }
            return this.crmOffline.schedule(
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
        });
        if (!this.crmOffline.isQueued(result)) {
            await this.crmReloadIfMobile();
        }
    }

    /**
     * Accessible name of the stage header's "New" button: its visible label followed
     * by the displayed stage, so that it is told apart from the control panel's
     * "New"; "New lead" for a stage without a name.
     *
     * @param {Object} group the displayed stage group
     * @returns {string}
     */
    crmNewLeadAriaLabel(group) {
        const stage = String(group.displayName ?? "").trim();
        return stage ? _t("New lead in %(stage)s", { stage }) : _t("New lead");
    }

    /**
     * Opens the quick-create bottom sheet on the displayed stage, leaving sample
     * mode first. Not offline where the queue cannot hold the create (non-secure
     * origin, "New" disabled): neither "New" nor the "New Lead" deep link opens a
     * sheet whose Save could never work.
     *
     * @param {HTMLElement} [target] the control opening the sheet, given the focus
     *  back when it closes
     */
    openQuickCreate(target) {
        const group = this.activeGroup;
        if (!this.canQuickCreate() || !group || this.crmOffline.isOfflineQueueBlocked()) {
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
        // Once opened: opening closes a sheet still open, which forgets its opener.
        this.crmQuickCreateOpener = target || null;
    }

    /**
     * Every close of the quick create (Save, Cancel, Escape, backdrop or swipe)
     * gives the focus back to its opener, else to the stage header's controls.
     */
    crmOnQuickCreateClosed() {
        const opener = this.crmQuickCreateOpener;
        this.crmQuickCreateOpener = null;
        crmReturnFocusFromSheet([opener, ...this.crmHeaderFocusTargets()]);
    }

    /**
     * Focus targets of the stage header when the focused control can no longer
     * hold the focus: "New", the stage navigation, then the stage name.
     *
     * @returns {(HTMLElement|null)[]}
     */
    crmHeaderFocusTargets() {
        const root = this.rootRef();
        return [
            ".o_crm_mobile_pipeline_new",
            ".o_crm_mobile_pipeline_next",
            ".o_crm_mobile_pipeline_prev",
            ".o_crm_mobile_pipeline_stage_name",
        ].map((selector) => root?.querySelector(`.o_crm_mobile_pipeline_header ${selector}`));
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
            this.crmShowStage(index);
        }
    }
}

// -----------------------------------------------------------------------------
// View
// -----------------------------------------------------------------------------

/**
 * Reuses the CRM kanban model, arch parser and search model. Cards compile with
 * `CrmLeadCardCompiler`, which disables a lead card menu's Delete where its
 * `unlink` cannot be queued offline.
 */
export const crmMobilePipelineView = {
    ...crmKanbanView,
    Compiler: CrmLeadCardCompiler,
    Controller: CrmMobilePipelineController,
    Renderer: CrmMobilePipeline,
};

registry.category("views").add("crm_mobile_pipeline", crmMobilePipelineView);
