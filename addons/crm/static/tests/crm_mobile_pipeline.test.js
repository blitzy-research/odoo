/**
 * Tests of the CRM mobile pipeline. They mount the real `crm_mobile_pipeline` view
 * registration (and `crm_form` for the lead form) and cover the pipeline, the lead
 * card, its activity sheet and the quick create. Queue and replay assertions read
 * genuine framework queue entries and their replays. The framework's expected
 * cached-root-load fallback errors and the injected server errors are declared with
 * `expect.errors()` and `expect.verifyErrors()`. Mobile tests run in the mobile
 * preset; the three desktop checks run in the desktop preset.
 */

import { after, beforeEach, expect, mockDate, mockUserAgent, test } from "@odoo/hoot";
import {
    advanceTime,
    animationFrame,
    click,
    getFocusableElements,
    manuallyDispatchProgrammaticEvent,
    press,
    queryAll,
    queryAllTexts,
    queryFirst,
    resize,
    runAllTimers,
    waitFor,
    waitUntil,
} from "@odoo/hoot-dom";
import { onMounted, onPatched, onWillDestroy, onWillPatch, toRaw } from "@odoo/owl";
import { mailModels } from "@mail/../tests/mail_test_helpers";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    makeMockServer,
    makeServerError,
    mockOffline as mockWebOffline,
    MockServer,
    models,
    mountView,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    serverState,
} from "@web/../tests/web_test_helpers";
import { defineCrmModels } from "@crm/../tests/crm_test_helpers";
import {
    CRM_SYNC_STATUS_DELAY,
    CrmMobileLeadActivities,
    CrmMobileLeadCard,
} from "@crm/mobile/crm_mobile_lead_card/crm_mobile_lead_card";
import {
    CrmMobilePipeline,
    CrmMobilePipelineController,
} from "@crm/mobile/crm_mobile_pipeline/crm_mobile_pipeline";
import {
    CRM_OFFLINE_CREATE_KEY,
    CRM_OFFLINE_UID_KEY,
    isQuickCreateDeepLink,
    quickCreateDeepLink,
} from "@crm/mobile/crm_offline_hooks";
import { CrmFormController } from "@crm/views/crm_form/crm_form";
import { AutoComplete } from "@web/core/autocomplete/autocomplete";
import { BottomSheet } from "@web/core/bottom_sheet/bottom_sheet";
import { browser } from "@web/core/browser/browser";
import { cookie } from "@web/core/browser/cookie";
import { Crypto } from "@web/core/crypto";
import { getCurrency } from "@web/core/currency";
import { rpc } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
import { registerTemplate } from "@web/core/templates";
import { user } from "@web/core/user";
import { IndexedDB } from "@web/core/utils/indexed_db";
import { formatMonetary } from "@web/views/fields/formatters";
import { Many2One } from "@web/views/fields/many2one/many2one";
import { buildM2OFieldDescription, Many2OneField } from "@web/views/fields/many2one/many2one_field";
import { Many2XAutocomplete } from "@web/views/fields/relational_utils";
import { AnimatedNumber } from "@web/views/view_components/animated_number";
import { WebClient } from "@web/webclient/webclient";

// -----------------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------------

/** Stage ids, in pipeline order. "Won" is folded, as in the CRM stage data. */
const NEW = 1;
const QUALIFIED = 2;
const WON = 3;

/** Activity type ids of the mail mock: 1 Email, 2 Call, 28 Upload Document. */
const CALL_TYPE_ID = 2;

/** Actions of the web client tests: Opportunities pipeline and Leads (grouped by stage). */
const ACTION_ID = 1;
const LEADS_ACTION_ID = 2;
/** View id of the Leads kanban arch. */
const LEADS_VIEW_ID = 2;
/** Pipeline action and view whose groups load two leads each (partially loaded groups). */
const LIMITED_ACTION_ID = 3;
const LIMITED_VIEW_ID = 3;
/**
 * Desktop references: actions and views of the same two arches with the CRM
 * kanban `js_class="crm_kanban"` (Opportunities pipeline, then Leads).
 */
const DESKTOP_ACTION_ID = 4;
const DESKTOP_VIEW_ID = 4;
const DESKTOP_LEADS_ACTION_ID = 5;
const DESKTOP_LEADS_VIEW_ID = 5;
/** Pipeline action whose lead form has the header buttons (Won, Lost). */
const BUTTONS_ACTION_ID = 6;
const BUTTONS_FORM_VIEW_ID = 6;
/** Leads action without grouping: the Leads kanban arch lists its leads in one column. */
const UNGROUPED_LEADS_ACTION_ID = 7;

class CrmStage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();
    sequence = fields.Integer();
    fold = fields.Boolean();
    is_won = fields.Boolean();

    _records = [
        { id: NEW, name: "New", sequence: 1 },
        { id: QUALIFIED, name: "Qualified", sequence: 2 },
        { id: WON, name: "Won", sequence: 3, fold: true, is_won: true },
    ];
}

class CrmTeam extends models.Model {
    _name = "crm.team";

    name = fields.Char();

    _records = [{ id: 1, name: "Sales" }];
}

class CrmLead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    type = fields.Selection({
        selection: [
            ["lead", "Lead"],
            ["opportunity", "Opportunity"],
        ],
        default: "opportunity",
    });
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });
    partner_id = fields.Many2one({ string: "Customer", relation: "res.partner" });
    contact_name = fields.Char({ string: "Contact Name" });
    email_from = fields.Char({ string: "Email" });
    phone = fields.Char({ string: "Phone" });
    expected_revenue = fields.Monetary({
        string: "Expected Revenue",
        currency_field: "company_currency",
        aggregator: "sum",
    });
    // Computed from the company on the server: the company currency (USD).
    company_currency = fields.Many2one({
        string: "Currency",
        relation: "res.currency",
        default: 1,
    });
    user_id = fields.Many2one({ string: "Salesperson", relation: "res.users" });
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });
    activity_ids = fields.One2many({
        string: "Activities",
        relation: "mail.activity",
        relation_field: "res_id",
    });
    activity_state = fields.Selection({
        string: "Activity State",
        selection: [
            ["overdue", "Overdue"],
            ["today", "Today"],
            ["planned", "Planned"],
        ],
    });
    activity_summary = fields.Char({ string: "Next Activity Summary" });
    activity_type_id = fields.Many2one({
        string: "Next Activity Type",
        relation: "mail.activity.type",
    });
    activity_exception_decoration = fields.Selection({
        selection: [
            ["warning", "Alert"],
            ["danger", "Error"],
        ],
    });
    activity_exception_icon = fields.Char();
    activity_type_icon = fields.Char();
    color = fields.Integer({ string: "Color Index" });
    active = fields.Boolean({ default: true });
    won_status = fields.Selection({
        string: "Is Won",
        selection: [
            ["won", "Won"],
            ["lost", "Lost"],
            ["pending", "Pending"],
        ],
        default: "pending",
    });
    probability = fields.Float({ string: "Probability" });

    // Views of the web client actions (the arches are defined below).
    _views = {
        "kanban,false": pipelineArch,
        [`kanban,${LEADS_VIEW_ID}`]: leadsArch,
        [`kanban,${LIMITED_VIEW_ID}`]: limitedPipelineArch,
        [`kanban,${DESKTOP_VIEW_ID}`]: desktopPipelineArch,
        [`kanban,${DESKTOP_LEADS_VIEW_ID}`]: desktopLeadsArch,
        "form,false": leadFormArch,
        [`form,${BUTTONS_FORM_VIEW_ID}`]: leadFormWithButtonsArch,
        "search,false": `<search/>`,
    };

    _records = [
        {
            id: 1,
            name: "Office Design",
            stage_id: NEW,
            partner_id: 101,
            expected_revenue: 100,
            company_currency: 1,
            user_id: serverState.userId,
            team_id: 1,
            activity_ids: [1, 2],
            activity_state: "planned",
            activity_summary: "Follow-up call",
            activity_type_id: CALL_TYPE_ID,
            probability: 10,
        },
        {
            id: 2,
            name: "Quote for Chairs",
            stage_id: NEW,
            contact_name: "Bob Contact",
            expected_revenue: 200,
            company_currency: 1,
            user_id: serverState.userId,
            team_id: 1,
            probability: 10,
        },
        {
            id: 3,
            name: "Desk Upgrade",
            stage_id: NEW,
            partner_id: 102,
            expected_revenue: 300,
            company_currency: 1,
            user_id: serverState.userId,
            team_id: 1,
            probability: 10,
        },
        {
            id: 4,
            name: "Conference Room",
            stage_id: QUALIFIED,
            partner_id: 102,
            expected_revenue: 400,
            company_currency: 1,
            user_id: serverState.userId,
            team_id: 1,
            activity_ids: [3],
            activity_state: "today",
            activity_summary: "Send the quote",
            activity_type_id: 1,
            probability: 40,
        },
        {
            id: 5,
            name: "Lamps",
            stage_id: QUALIFIED,
            contact_name: "Lamp Buyer",
            expected_revenue: 50,
            company_currency: 1,
            user_id: serverState.userId,
            team_id: 1,
            probability: 40,
        },
        {
            id: 6,
            name: "Storage Racks",
            stage_id: QUALIFIED,
            expected_revenue: 250,
            company_currency: 1,
            user_id: serverState.userId,
            team_id: 1,
            probability: 40,
        },
        {
            id: 7,
            name: "Signed Deal",
            stage_id: WON,
            partner_id: 101,
            expected_revenue: 900,
            company_currency: 1,
            user_id: serverState.userId,
            team_id: 1,
            won_status: "won",
            probability: 100,
        },
    ];
}

/** Activities of leads 1 (two) and 4 (one), set on the mail mock in `beforeEach`. */
const ACTIVITY_RECORDS = [
    {
        id: 1,
        res_model: "crm.lead",
        res_id: 1,
        activity_type_id: CALL_TYPE_ID,
        summary: "Follow-up call",
        date_deadline: "2026-10-05",
        user_id: serverState.userId,
        state: "planned",
    },
    {
        id: 2,
        res_model: "crm.lead",
        res_id: 1,
        activity_type_id: 1,
        summary: "Send brochure",
        date_deadline: "2026-10-09",
        user_id: serverState.userId,
        state: "planned",
    },
    {
        id: 3,
        res_model: "crm.lead",
        res_id: 4,
        activity_type_id: 1,
        summary: "Send the quote",
        date_deadline: "2026-10-02",
        user_id: serverState.userId,
        state: "today",
    },
];

defineCrmModels();
defineModels([CrmStage, CrmTeam, CrmLead]);
defineActions([
    {
        id: ACTION_ID,
        name: "Pipeline",
        res_model: "crm.lead",
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
        context: { default_type: "opportunity" },
        search_view_id: [false, "search"],
    },
    {
        id: LEADS_ACTION_ID,
        name: "Leads",
        res_model: "crm.lead",
        views: [
            [LEADS_VIEW_ID, "kanban"],
            [false, "form"],
        ],
        context: { group_by: ["stage_id"] },
        search_view_id: [false, "search"],
    },
    {
        id: LIMITED_ACTION_ID,
        name: "Pipeline",
        res_model: "crm.lead",
        views: [
            [LIMITED_VIEW_ID, "kanban"],
            [false, "form"],
        ],
        context: { default_type: "opportunity" },
        search_view_id: [false, "search"],
    },
    {
        id: DESKTOP_ACTION_ID,
        name: "Pipeline",
        res_model: "crm.lead",
        views: [
            [DESKTOP_VIEW_ID, "kanban"],
            [false, "form"],
        ],
        context: { default_type: "opportunity" },
        search_view_id: [false, "search"],
    },
    {
        id: DESKTOP_LEADS_ACTION_ID,
        name: "Leads",
        res_model: "crm.lead",
        views: [
            [DESKTOP_LEADS_VIEW_ID, "kanban"],
            [false, "form"],
        ],
        context: { group_by: ["stage_id"] },
        search_view_id: [false, "search"],
    },
    {
        id: BUTTONS_ACTION_ID,
        name: "Pipeline",
        res_model: "crm.lead",
        views: [
            [false, "kanban"],
            [BUTTONS_FORM_VIEW_ID, "form"],
        ],
        context: { default_type: "opportunity" },
        search_view_id: [false, "search"],
    },
    {
        id: UNGROUPED_LEADS_ACTION_ID,
        name: "Leads",
        res_model: "crm.lead",
        views: [
            [LEADS_VIEW_ID, "kanban"],
            [false, "form"],
        ],
        search_view_id: [false, "search"],
    },
]);

// The mail mock defines no `action_done`: it removes the activity, as the server
// does (an activity marked done leaves `activity_ids`).
onRpc("mail.activity", "action_done", function actionDone({ args }) {
    this.env["mail.activity"].unlink(args[0]);
    return true;
});

// `crm.lead.action_set_won`, replayed after an offline "Won": the lead moves to the
// won stage, won at 100%.
onRpc("crm.lead", "action_set_won", function actionSetWon({ args }) {
    this.env["crm.lead"].write(args[0], { stage_id: WON, won_status: "won", probability: 100 });
    return true;
});

/** Enrichment suggestions selected in the partner field, emptied before each test. */
const enrichmentSelections = [];

/**
 * Stand-in for the lead form's `res_partner_many2one` widget
 * (`PartnerAutoCompleteMany2one`), registered under that arch name for each test.
 * Its addon, `partner_autocomplete`, auto-installs with CRM's dependencies but is
 * outside CRM's `depends`, so the unit-test module set of `@crm` does not load it,
 * and CRM imports nothing from it. The stand-in keeps the widget's contract without
 * its requests: a many2one whose `otherSources` adds an enrichment suggestion for
 * queries longer than two characters, only when the field can create.
 */
class EnrichmentPartnerMany2One extends Many2OneField {
    get m2oProps() {
        return { ...super.m2oProps, otherSources: this.enrichmentSources };
    }

    get enrichmentSources() {
        if (!this.props.canCreate) {
            return [];
        }
        return [
            {
                options: (request) =>
                    request && request.length > 2
                        ? [
                              {
                                  cssClass: "partner_autocomplete_dropdown_many2one",
                                  data: { name: "Azure Interior SA" },
                                  label: "Azure Interior SA",
                                  onSelect: () => enrichmentSelections.push("Azure Interior SA"),
                              },
                          ]
                        : [],
            },
        ];
    }
}

beforeEach(() => {
    patchWithCleanup(AnimatedNumber, { enableAnimations: false });
    enrichmentSelections.length = 0;
    // Restored after each test with the rest of the registries.
    registry
        .category("fields")
        .add("res_partner_many2one", buildM2OFieldDescription(EnrichmentPartnerMany2One));
    // Shared mail fixture overrides, reset after each test.
    mailModels.ResPartner._records = [
        { id: 101, name: "Azure Interior" },
        { id: 102, name: "Deco Addict" },
        ...mailModels.ResPartner._records,
    ];
    mailModels.MailActivity._records = ACTIVITY_RECORDS.map((record) => ({ ...record }));
    // The activity-type warm-up of the activity sheet filters the types on `res_model`.
    mailModels.MailActivityType._fields.res_model = fields.Char({ string: "Model" });
});

// -----------------------------------------------------------------------------
// Arches: CRM lead kanbans and form with the mobile view class and Call-type option.
// -----------------------------------------------------------------------------

/**
 * Builds a kanban arch of the CRM Opportunities pipeline
 * (`crm.crm_case_kanban_view_leads`) with the given `js_class`.
 *
 * @param {string} jsClass
 * @param {string} [extraAttrs] additional `<kanban>` attributes (e.g. `limit`)
 */
function makePipelineArch(jsClass, extraAttrs = "") {
    return /* xml */ `
        <kanban js_class="${jsClass}" highlight_color="color" default_group_by="stage_id"
            class="o_kanban_small_column o_opportunity_kanban" on_create="quick_create"
            archivable="false" ${extraAttrs}>
            <field name="stage_id"/>
            <field name="probability"/>
            <field name="active"/>
            <field name="company_currency"/>
            <field name="team_id"/>
            <field name="won_status"/>
            <progressbar field="activity_state"
                colors='{"planned": "success", "today": "warning", "overdue": "danger"}'
                sum_field="expected_revenue"/>
            <templates>
                <t t-name="menu">
                    <t t-if="widget.editable"><a role="menuitem" type="open" class="dropdown-item">Edit</a></t>
                    <t t-if="widget.deletable"><a role="menuitem" type="delete" class="dropdown-item">Delete</a></t>
                    <div role="separator" class="dropdown-divider"/>
                    <field name="color" widget="kanban_color_picker"/>
                </t>
                <t t-name="card">
                    <field class="fw-bold fs-5" name="name"/>
                    <div class="o_kanban_card_crm_lead_revenue">
                        <field name="expected_revenue" widget="monetary" options="{'currency_field': 'company_currency'}"/>
                    </div>
                    <field name="partner_id"/>
                    <field name="contact_name" invisible="partner_id"/>
                    <footer class="pt-1">
                        <div class="d-flex mt-auto align-items-center">
                            <field name="activity_ids" widget="kanban_activity" options="{'crm_call_activity_type_id': ${CALL_TYPE_ID}}"/>
                        </div>
                        <field name="user_id" class="ms-auto"/>
                    </footer>
                </t>
            </templates>
        </kanban>`;
}

/**
 * Builds a kanban arch of the CRM Leads mobile kanban (`crm.view_crm_lead_kanban`)
 * with the given `js_class`: no `partner_id`, `expected_revenue` or `stage_id`, and
 * a progress bar without sum field.
 *
 * @param {string} jsClass
 */
function makeLeadsArch(jsClass) {
    return /* xml */ `
        <kanban class="o_kanban_mobile" archivable="false" js_class="${jsClass}">
            <progressbar field="activity_state"
                colors='{"planned": "success", "today": "warning", "overdue": "danger"}'/>
            <templates>
                <t t-name="card">
                    <field name="name" class="fw-bold fs-5"/>
                    <field name="contact_name"/>
                    <footer class="pt-1 mt-0">
                        <div class="d-flex mt-auto">
                            <field name="activity_ids" widget="kanban_activity" options="{'crm_call_activity_type_id': ${CALL_TYPE_ID}}"/>
                        </div>
                        <field name="user_id" class="ms-auto"/>
                    </footer>
                </t>
            </templates>
        </kanban>`;
}

const pipelineArch = makePipelineArch("crm_mobile_pipeline");
const leadsArch = makeLeadsArch("crm_mobile_pipeline");
const desktopPipelineArch = makePipelineArch("crm_kanban");
const desktopLeadsArch = makeLeadsArch("crm_kanban");
/** Pipeline arch loading two leads per stage, below every unfolded stage's count. */
const limitedPipelineArch = makePipelineArch("crm_mobile_pipeline", 'limit="2"');

/** The lead form (`crm.crm_lead_view_form`), reduced to the fields used here. */
const leadFormArch = /* xml */ `
    <form js_class="crm_form">
        <header>
            <field name="stage_id" widget="rotting_statusbar_duration"
                options="{'clickable': '1', 'fold_field': 'fold', 'crm_call_activity_type_id': ${CALL_TYPE_ID}}"/>
        </header>
        <sheet>
            <field name="won_status" invisible="1"/>
            <field name="active" invisible="1"/>
            <field name="company_currency" invisible="1"/>
            <field name="name"/>
            <field name="partner_id" widget="res_partner_many2one"/>
            <field name="contact_name"/>
            <field name="email_from"/>
            <field name="phone"/>
            <field name="expected_revenue" widget="monetary" options="{'currency_field': 'company_currency'}"/>
            <field name="probability"/>
            <field name="user_id"/>
            <field name="team_id"/>
        </sheet>
    </form>`;

/**
 * The lead form with its header buttons: "Won" (`data-available-offline`, queued
 * offline by the CRM form) and "Lost" (a wizard action, disabled offline).
 */
const leadFormWithButtonsArch = leadFormArch.replace(
    "<header>",
    /* xml */ `<header>
            <button name="action_set_won_rainbowman" string="Won" type="object"
                class="oe_highlight" title="Mark as won" data-available-offline="1"/>
            <button name="crm.crm_lead_lost_action" string="Lost" type="action"
                title="Mark as lost"/>`
);

/**
 * A mobile pipeline arch with neither a progress bar nor `activity_ids`: the
 * mobile variant adds the activity rows, the arch's own (desktop) variant has none.
 */
const plainPipelineArch = /* xml */ `
    <kanban js_class="crm_mobile_pipeline" default_group_by="stage_id">
        <field name="stage_id"/>
        <templates>
            <t t-name="card">
                <field class="fw-bold fs-5" name="name"/>
                <field name="partner_id"/>
            </t>
        </templates>
    </kanban>`;

/** Action context of the Opportunities pipeline action. */
const PIPELINE_CONTEXT = { default_type: "opportunity" };

/** A quick create's delivery key (`CRM_OFFLINE_CREATE_KEY`): 32 lowercase hex digits. */
const DELIVERY_KEY = /^[0-9a-f]{32}$/;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * The web test helpers' `mockOffline`, whose `setOffline(true)` first waits until
 * mail's start-up store fetch has completed. That fetch (`init_messaging`, with the
 * messaging menu counters) leaves through a debounced `/mail/store` request after
 * the services start: on a loaded host it would only leave once the network is cut,
 * and mail does not handle its rejection, so the test would fail on an error beside
 * the framework's cached root-load errors it declares. Reconnections, and
 * disconnections once the store is ready, apply at once, as with the web helper.
 * Like it, it registers its offline route handler when called.
 *
 * @returns {(offline: boolean) => Promise<void>}
 */
function mockOffline() {
    const setOffline = mockWebOffline();
    let storeReady = false;
    return (offline) => {
        const store = getService("mail.store");
        if (!offline || storeReady || !store.initialized) {
            return setOffline(offline);
        }
        return store.isReadyPromise.then(() => {
            storeReady = true;
            return setOffline(true);
        });
    };
}

/**
 * Queued calls of a model in the framework queue, as `{key, model, method, args,
 * kwargs, extras}`, in replay order.
 *
 * @param {string} model
 */
function queued(model) {
    return Object.values(getService(OfflinePlugin)._ormToSync())
        .filter(({ value }) => value.model === model)
        .sort((a, b) => (a.value.extras?.timeStamp || 0) - (b.value.extras?.timeStamp || 0))
        .map(({ key, value }) => ({ key, ...value }));
}

/**
 * The ORM call of a queue entry or of a received request.
 *
 * @param {{model: string, method: string, args: any[], kwargs: Object}} call
 */
function ormCall({ model, method, args, kwargs }) {
    return { model, method, args, kwargs };
}

/**
 * Records each `model`/`method` call the mock server receives, a replayed queued
 * call included, as a copy of its `ormCall`, in arrival order. Its handler returns
 * nothing, so the other handlers of the call still answer it.
 *
 * @param {string} model
 * @param {string} method
 * @returns {Object[]} the recorded calls, filled as they arrive
 */
function receivedCalls(model, method) {
    const calls = [];
    onRpc(model, method, (call) => {
        calls.push(JSON.parse(JSON.stringify(ormCall(call))));
    });
    return calls;
}

/**
 * A `trackCalls()` entry of a write: a save, resequence, create, write, unlink or
 * action call.
 */
const WRITE_CALL = /\/(?:web_save|web_resequence|(?:name_)?create|write|unlink|action_\w+)$/;

/**
 * Captures the kwargs of every `crm.lead` root load request (`web_read_group`
 * grouped, `web_search_read` ungrouped): `{method, specification, aggregates}`.
 * Group loads (`web_search_read` with a group domain) are recorded too, flagged
 * by `method`.
 */
function rootSpecs() {
    const specs = [];
    onRpc("crm.lead", "web_read_group", ({ kwargs }) => {
        specs.push({
            method: "web_read_group",
            specification: kwargs.unfold_read_specification,
            aggregates: kwargs.aggregates,
        });
    });
    onRpc("crm.lead", "web_search_read", ({ kwargs }) => {
        specs.push({ method: "web_search_read", specification: kwargs.specification });
    });
    return specs;
}

/**
 * Records every ORM request reaching the network layer, online or offline, as
 * `"<model>/<method>"`. Must be registered after `mockOffline()`, so that it sees
 * the requests the offline mock answers with a 502.
 */
function trackCalls() {
    const calls = [];
    onRpc("/*", (request) => {
        const match = new URL(request.url).pathname.match(
            /^\/web\/dataset\/call_kw\/([^/]+)\/([^/]+)/
        );
        if (match) {
            calls.push(`${match[1]}/${match[2]}`);
        }
    });
    return calls;
}

/**
 * Makes the next request of each `"<model>/<method>"` added to the returned set
 * fail as a lost connection (a 502, as the offline mock answers) while the network
 * stays up: the framework turns offline on that response, and online again on the
 * next successful one. Must be registered after `mockOffline()`.
 *
 * @returns {Set<string>}
 */
function dropConnections() {
    const drops = new Set();
    onRpc("/*", (request) => {
        const match = new URL(request.url).pathname.match(
            /^\/web\/dataset\/call_kw\/([^/]+\/[^/]+)/
        );
        if (match && drops.delete(match[1])) {
            return new Response("", { status: 502 });
        }
    });
    return drops;
}

/**
 * Records every `crm.lead` grouped root request (`web_read_group`) sent to the
 * network, online or offline (a request served from the RPC cache is sent too), as
 * `[sendsOpeningInfo, isMobileVariant]`: whether it sends the opening info of the
 * groups, and whether it reads the mobile variant's activity rows.
 *
 * @returns {[boolean, boolean][]} the recorded requests, filled as they are sent
 */
function rootRequests() {
    const requests = [];
    const { _rpc } = rpc;
    patchWithCleanup(rpc, {
        _rpc(url, params, settings) {
            if (!settings?.cache && url.endsWith("/crm.lead/web_read_group")) {
                const { opening_info, unfold_read_specification } = params.kwargs;
                const activityFields = unfold_read_specification.activity_ids?.fields || {};
                requests.push([opening_info !== undefined, "summary" in activityFields]);
            }
            return _rpc.call(this, url, params, settings);
        },
    });
    return requests;
}

/**
 * Mounts the mobile pipeline view on `crm.lead`, grouped by stage.
 *
 * @param {Object} [params] `mountView` params overriding the defaults
 */
function mountPipeline(params = {}) {
    return mountView({
        type: "kanban",
        resModel: "crm.lead",
        arch: pipelineArch,
        groupBy: ["stage_id"],
        context: PIPELINE_CONTEXT,
        config: { actionId: ACTION_ID },
        ...params,
    });
}

/**
 * Text of the first element matching `selector`, with non-breaking spaces
 * normalized, or `null` when there is none.
 *
 * @param {string} selector
 */
function textOf(selector) {
    const el = queryFirst(selector);
    return el ? el.textContent.replace(/\u00a0/g, " ").trim() : null;
}

/** Texts of the mobile stage header: `[stage name, count, revenue]`. */
function headerTexts() {
    return [
        textOf(".o_crm_mobile_pipeline_stage_name"),
        textOf(".o_crm_mobile_pipeline_count"),
        textOf(".o_crm_mobile_pipeline_revenue"),
    ];
}

/** Names of the lead cards of the displayed stage (provisional cards included). */
function cardNames() {
    return queryAllTexts(".o_crm_mobile_lead_card .o_crm_mobile_lead_name");
}

/**
 * The lead card showing `name`, as a selector usable with `contains`.
 *
 * @param {string} name
 */
function card(name) {
    return `.o_crm_mobile_lead_card:has(.o_crm_mobile_lead_name:text(${name}))`;
}

/**
 * A horizontal (or diagonal) touch gesture on the stage body.
 *
 * @param {number} dx horizontal travel in px (negative: towards the left)
 * @param {number} [dy] vertical travel in px
 */
async function swipe(dx, dy = 0) {
    const body = queryFirst(".o_crm_mobile_pipeline_body");
    await manuallyDispatchProgrammaticEvent(body, "touchstart", { clientX: 200, clientY: 300 });
    await manuallyDispatchProgrammaticEvent(body, "touchend", {
        clientX: 200 + dx,
        clientY: 300 + dy,
    });
    await animationFrame();
}

/**
 * Opens the quick-create sheet from the stage header and saves a lead.
 * `edit(..., { confirm: false })`: Enter would submit the sheet's form early.
 *
 * @param {{name: string, revenue?: number, stageId?: number, contact?: string}} values
 */
async function quickCreateLead({ name, revenue, stageId, contact }) {
    await contains(".o_crm_mobile_pipeline_new").click();
    await contains("form.o_crm_mobile_quick_create input[name=name]").edit(name, {
        confirm: false,
    });
    if (contact) {
        await contains("form.o_crm_mobile_quick_create input[name=contact_name]").edit(contact, {
            confirm: false,
        });
    }
    if (revenue !== undefined) {
        await contains("form.o_crm_mobile_quick_create input[name=expected_revenue]").edit(
            String(revenue),
            { confirm: false }
        );
    }
    if (stageId) {
        await contains("form.o_crm_mobile_quick_create select[name=stage_id]").select(
            String(stageId)
        );
    }
    await contains(".o_crm_mobile_quick_create_save").click();
}

/**
 * Restores connectivity, advances replay for at most 30 seconds while unparked
 * calls or a sync remain, then allows view reconciliation.
 *
 * @param {(offline: boolean) => Promise<void>} setOffline
 */
async function reconnect(setOffline) {
    await setOffline(false);
    const plugin = getService(OfflinePlugin);
    const hasCallsToReplay = () =>
        Object.values(plugin._ormToSync()).some(({ value }) => !value.extras?.error);
    // The replay waits one second between two calls.
    for (let i = 0; i < 30 && (plugin.syncingORM() || hasCallsToReplay()); i++) {
        await advanceTime(1000);
    }
    await animationFrame();
    await animationFrame();
}

/** Opens an action of the web client, as a fresh breadcrumb root. */
async function openAction(actionId) {
    await getService("action").doAction(actionId, { clearBreadcrumbs: true });
}

/**
 * Opens a lead form from its pipeline card and goes back to the pipeline
 * (mobile breadcrumb back button), which marks the lead visited.
 *
 * @param {string} name
 */
async function visitLead(name) {
    await contains(`${card(name)} .o_crm_mobile_lead_open`).click();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_back_button").click();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
}

// -----------------------------------------------------------------------------
// Pipeline (CrmMobilePipeline, CrmMobilePipelineController)
// -----------------------------------------------------------------------------

test.tags("mobile");
test("mobile pipeline shows one stage with name, count and revenue", async () => {
    expect.errors(2);
    let holdGroupLoads = null;
    onRpc("crm.lead", "web_search_read", () => holdGroupLoads?.promise);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);

    // Online, both CRM lead kanban arches, grouped by stage.
    for (const actionId of [ACTION_ID, LEADS_ACTION_ID]) {
        await openAction(actionId);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
        expect(".o_kanban_group").toHaveCount(0);
        expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
        expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
        await contains(".o_crm_mobile_pipeline_next").click();
        expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
        expect(".o_crm_mobile_pipeline_revenue .o_animated_number").toHaveCount(1);
    }

    // Offline, both served from the cache.
    await setOffline(true);
    for (const actionId of [ACTION_ID, LEADS_ACTION_ID]) {
        await openAction(actionId);
        expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
        await contains(".o_crm_mobile_pipeline_next").click();
        expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
    }

    // A progress-bar filter selected on a wide screen stays active on the phone: the
    // header shows the filtered count, also when it is 0, and no (unfiltered) revenue.
    await setOffline(false);
    await openAction(ACTION_ID);
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_group").toHaveCount(3);
    await contains(".o_kanban_group:first .progress-bar.bg-success").click();
    expect(".o_kanban_group:first .o_kanban_record").toHaveCount(1);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "1", null]);
    expect(cardNames()).toEqual(["Office Design"]);

    // Meanwhile, the only planned activity of the stage is done on the server: after a
    // reload the active bar counts 0 until the framework drops the empty filter (its
    // group reload is held here to observe that state).
    MockServer.env["crm.lead"].write([1], { activity_state: false });
    holdGroupLoads = Promise.withResolvers();
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "0", null]);
    holdGroupLoads.resolve();
    holdGroupLoads = null;
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile pipeline header follows offline create, edit, move and replay", async () => {
    expect.errors(2);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    // Two leads loaded per stage: both unfolded stages hold more leads than loaded.
    await openAction(LIMITED_ACTION_ID);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);
    await visitLead("Office Design");

    await setOffline(true);

    // Offline quick create: +1 lead and its revenue in its stage.
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    expect(headerTexts()).toEqual(["New", "4", "$ 650"]);

    // Offline form edit of the expected revenue: the sum follows.
    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();
    await contains(".o_field_widget[name=expected_revenue] input").edit("160");
    await contains(".o_form_button_save").click();
    await contains(".o_back_button").click();
    expect(headerTexts()).toEqual(["New", "4", "$ 710"]);

    // Offline move from a partially loaded stage: the amount leaves the source and
    // joins the target once, and each count changes by one.
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_stage`).select(
        String(QUALIFIED)
    );
    expect(headerTexts()).toEqual(["New", "3", "$ 510"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 900"]);
    expect(queued("crm.lead").map(({ method }) => method)).toEqual([
        "web_save",
        "web_save",
        "web_save",
    ]);

    // After the replay and the reload, the header shows the server values.
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 900"]);
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(headerTexts()).toEqual(["New", "3", "$ 510"]);
    expect(
        MockServer.env["crm.lead"].search_read(
            [["stage_id", "=", NEW]],
            ["name", "expected_revenue", "type"]
        )
    ).toEqual([
        { id: 1, name: "Office Design", expected_revenue: 160, type: "opportunity" },
        { id: 3, name: "Desk Upgrade", expected_revenue: 300, type: "opportunity" },
        { id: 8, name: "Offline Lead", expected_revenue: 50, type: "opportunity" },
    ]);
    // The framework's own cached root loads (form and pipeline) offline.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile pipeline header keeps the current root's server values when an older load ends last", async () => {
    let controller = null;
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    // Progress-bar responses to hold, in request order: a root load installs its
    // root, then waits for its progress bar (`onRootLoaded`) before it resolves.
    const heldProgressBars = [];
    onRpc("crm.lead", "read_progress_bar", () => heldProgressBars.shift()?.promise);
    const setOffline = mockOffline();
    await mountPipeline();
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    // Both stages visited online.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();

    // Root load A installs its root, then waits for its progress bar.
    const progressA = Promise.withResolvers();
    heldProgressBars.push(progressA);
    const initialRootId = controller.model.root.id;
    const loadA = controller.model.load();
    await animationFrame();
    const rootAId = controller.model.root.id;
    expect(rootAId).not.toBe(initialRootId);
    expect(heldProgressBars).toEqual([]);

    // The server revenue of "Quote for Chairs" changes, then root load B installs
    // its root: while B waits for its own progress bar, the header uses B's values.
    MockServer.env["crm.lead"].write([2], { expected_revenue: 1000 });
    const progressB = Promise.withResolvers();
    heldProgressBars.push(progressB);
    const loadB = controller.model.load();
    await animationFrame();
    expect(controller.model.root.id).not.toBe(rootAId);
    expect(headerTexts()).toEqual(["New", "3", "$ 1,400"]);
    progressB.resolve();
    await loadB;
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "3", "$ 1,400"]);

    // A ends last: the snapshot stays the one of the current root (B).
    progressA.resolve();
    await loadA;
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "3", "$ 1,400"]);
    expect(controller.model.crmServerValues.get(2)).toEqual({ stageId: NEW, revenue: 1000 });

    // A queued move out of the stage leaves B's aggregates corrected by B's values.
    await setOffline(true);
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_stage`).select(
        String(QUALIFIED)
    );
    expect(headerTexts()).toEqual(["New", "2", "$ 400"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 1,700"]);
});

test.tags("mobile");
test("mobile pipeline header keeps the displayed root's server values while a search loads", async () => {
    let controller = null;
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    // Progress-bar responses to hold, in request order: a root load installs its
    // root, then waits for its progress bar (`onRootLoaded`) before it resolves.
    const heldProgressBars = [];
    onRpc("crm.lead", "read_progress_bar", () => heldProgressBars.shift()?.promise);
    await mountPipeline();
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    // Both stages visited.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();
    const displayedRoot = toRaw(controller.model.root);

    // The server revenue of "Quote for Chairs" changes, then a search reloads the
    // root: the search's load installs its root, then waits for its progress bar,
    // and the view keeps displaying the previous root until that load ends.
    MockServer.env["crm.lead"].write([2], { expected_revenue: 1000 });
    const progress = Promise.withResolvers();
    heldProgressBars.push(progress);
    controller.env.searchModel.splitAndAddDomain(`[("id", "!=", 0)]`);
    await animationFrame();
    expect(heldProgressBars).toEqual([]);
    expect(toRaw(controller.model.root)).not.toBe(displayedRoot);

    // Rendered meanwhile (here by stage navigation), the header of the displayed
    // root corrects that root's aggregates with that root's server values.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);

    // The search's load ends: its root and its server values show.
    progress.resolve();
    await animationFrame();
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "3", "$ 1,400"]);
});

/**
 * Answers the grouped (`web_read_group`) and group (`web_search_read`) lead loads
 * with every set `stage_id` of their raw records as `[id, display_name]`, a
 * many2one representation the relational model also accepts. A lead without
 * stage keeps `false`.
 */
function sendStagesAsPairs() {
    const toPairs = (records) => {
        for (const record of records || []) {
            const stage = record.stage_id;
            if (stage && typeof stage === "object" && !Array.isArray(stage)) {
                record.stage_id = [stage.id, stage.display_name];
            }
        }
    };
    onRpc("crm.lead", "web_read_group", async ({ parent }) => {
        const result = await parent();
        for (const group of result.groups) {
            toPairs(group.__records);
        }
        return result;
    });
    onRpc("crm.lead", "web_search_read", async ({ parent }) => {
        const result = await parent();
        toPairs(result.records);
        return result;
    });
}

test.tags("mobile");
test("mobile pipeline header counts once the revenue of leads whose stage arrives as an id and name pair", async () => {
    let controller = null;
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    sendStagesAsPairs();
    onRpc("crm.lead", "get_rainbowman_message", () => false);
    const setOffline = mockOffline();
    // Two leads loaded per stage: both unfolded stages hold more leads than loaded.
    await mountPipeline({ arch: limitedPipelineArch });

    // The snapshot holds the numeric server stage of each loaded lead, and each
    // unchanged lead counts its revenue once: the headers equal the server sums.
    expect([...controller.model.crmServerValues]).toEqual([
        [1, { stageId: NEW, revenue: 100 }],
        [2, { stageId: NEW, revenue: 200 }],
        [4, { stageId: QUALIFIED, revenue: 400 }],
        [5, { stageId: QUALIFIED, revenue: 50 }],
    ]);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
    await contains(".o_crm_mobile_pipeline_prev").click();

    // Online move out of the partially loaded "New": the amount leaves the source
    // and joins the target once. The source reload brings "Desk Upgrade", whose
    // server stage is recorded; the moved lead keeps its first server values.
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_stage`).select(
        String(QUALIFIED)
    );
    expect(cardNames()).toEqual(["Office Design", "Desk Upgrade"]);
    expect(headerTexts()).toEqual(["New", "2", "$ 400"]);
    expect(controller.model.crmServerValues.get(2)).toEqual({ stageId: NEW, revenue: 200 });
    expect(controller.model.crmServerValues.get(3)).toEqual({ stageId: NEW, revenue: 300 });
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 900"]);

    // Offline move out of the partially loaded "Qualified" (three of its four leads
    // loaded): the same, queued.
    await setOffline(true);
    await contains(`${card("Lamps")} .o_crm_mobile_lead_stage`).select(String(NEW));
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 850"]);
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(headerTexts()).toEqual(["New", "3", "$ 450"]);
    expect(queued("crm.lead").map(({ method, args }) => ({ method, args }))).toEqual([
        { method: "web_save", args: [[5], { stage_id: NEW }] },
    ]);

    // After the replay and the reload, the header shows the server values.
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(headerTexts()).toEqual(["New", "3", "$ 450"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 850"]);
    expect(controller.model.crmServerValues.get(2)).toEqual({ stageId: QUALIFIED, revenue: 200 });
});

test.tags("mobile");
test("mobile pipeline header counts once the revenue of a lead without stage", async () => {
    let controller = null;
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    await makeMockServer();
    const leadId = MockServer.env["crm.lead"].create({
        name: "Stageless Deal",
        stage_id: false,
        expected_revenue: 75,
        company_currency: 1,
        user_id: serverState.userId,
        team_id: 1,
    });
    // The other leads' stages arrive as `[id, name]`, this one's as `false`.
    sendStagesAsPairs();
    const setOffline = mockOffline();
    await mountPipeline();
    expect(controller.model.crmServerValues.get(leadId)).toEqual({
        stageId: false,
        revenue: 75,
    });
    expect(controller.model.crmServerValues.get(1)).toEqual({ stageId: NEW, revenue: 100 });
    expect(headerTexts()).toEqual(["None", "1", "$ 75"]);
    expect(cardNames()).toEqual(["Stageless Deal"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    await contains(".o_crm_mobile_pipeline_prev").click();

    // Moved offline to a stage: its amount leaves the "None" group for the stage once.
    await setOffline(true);
    await contains(`${card("Stageless Deal")} .o_crm_mobile_lead_stage`).select(String(NEW));
    expect(headerTexts()).toEqual(["None", "0", "$ 0"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["New", "4", "$ 675"]);
});

test.tags("mobile");
test("mobile pipeline navigates adjacent stages", async () => {
    await mountPipeline();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("New");
    expect(".o_crm_mobile_pipeline_prev").toHaveAttribute("disabled");
    expect(".o_crm_mobile_pipeline_next").not.toHaveAttribute("disabled");

    // Buttons, within bounds. The folded "Won" stage is loaded when reached.
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Qualified");
    expect(cardNames()).toEqual(["Conference Room", "Lamps", "Storage Racks"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Won", "1", "$ 900"]);
    expect(cardNames()).toEqual(["Signed Deal"]);
    expect(".o_crm_mobile_pipeline_next").toHaveAttribute("disabled");
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Qualified");

    // Swipes: left shows the next stage, right the previous one, within bounds.
    await swipe(-120);
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Won");
    await swipe(-120);
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Won");
    await swipe(120);
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Qualified");
    await swipe(120);
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("New");
    await swipe(120);
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("New");

    // Below the 50 px threshold, or mostly vertical: no stage change.
    await swipe(-49);
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("New");
    await swipe(-60, 120);
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("New");
    await swipe(-50);
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Qualified");

    // A touch end without its touch start (gesture begun elsewhere): no change.
    await manuallyDispatchProgrammaticEvent(queryFirst(".o_crm_mobile_pipeline_body"), "touchend", {
        clientX: 0,
        clientY: 300,
    });
    await animationFrame();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Qualified");
});

// -----------------------------------------------------------------------------
// Coming back to the pipeline: the stage and the scroll offset it was left at
// -----------------------------------------------------------------------------

const STAGE_NAME = ".o_crm_mobile_pipeline_stage_name";

/**
 * Adds `count` leads to a stage on the mock server, named `"<prefix> <n>"`: the
 * stage's cards then outgrow the view's content area, which scrolls them.
 *
 * @param {number} stageId
 * @param {number} count
 * @param {string} prefix
 */
function addLeads(stageId, count, prefix) {
    MockServer.env["crm.lead"].create(
        Array.from({ length: count }, (_, i) => ({
            name: `${prefix} ${i + 1}`,
            stage_id: stageId,
            expected_revenue: 10,
            company_currency: 1,
            user_id: serverState.userId,
            team_id: 1,
        }))
    );
}

/** The element scrolling the stage pipeline: the view's content area. */
function pipelineScroller() {
    return queryFirst(".o_kanban_view .o_content");
}

/**
 * Scrolls the stage pipeline to `top` px, after checking that its cards overflow
 * the content area by more than that.
 *
 * @param {number} top
 */
async function scrollPipeline(top) {
    const scroller = pipelineScroller();
    expect(scroller.scrollHeight - scroller.clientHeight).toBeGreaterThan(top);
    scroller.scrollTop = top;
    await animationFrame();
    expect(scroller.scrollTop).toBe(top);
}

/** The stage pipeline's place in the current action's global state, parsed. */
function exportedPipelineState() {
    const { globalState } = getService("action").currentController.action;
    return globalState && "crmMobilePipeline" in globalState
        ? JSON.parse(globalState.crmMobilePipeline)
        : null;
}

test.tags("mobile");
test("mobile pipeline back button returns to the stage and scroll offset it was left at", async () => {
    await makeMockServer();
    addLeads(QUALIFIED, 20, "Qualified lead");
    addLeads(WON, 20, "Won lead");
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(textOf(STAGE_NAME)).toBe("Qualified");
    await scrollPipeline(150);

    await contains(`${card("Lamps")} .o_crm_mobile_lead_open`).click();
    expect(".o_form_view").toHaveCount(1);
    expect(exportedPipelineState()).toEqual({ stageId: QUALIFIED, scrollTop: 150 });
    await contains(".o_back_button").click();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(textOf(STAGE_NAME)).toBe("Qualified");
    expect(cardNames().slice(0, 3)).toEqual(["Conference Room", "Lamps", "Storage Racks"]);
    expect(pipelineScroller().scrollTop).toBe(150);

    // A folded stage is loaded again when shown again: its offset is applied once
    // its cards are rendered.
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(textOf(STAGE_NAME)).toBe("Won");
    await scrollPipeline(120);
    await contains(`${card("Won lead 3")} .o_crm_mobile_lead_open`).click();
    expect(".o_form_view").toHaveCount(1);
    expect(exportedPipelineState()).toEqual({ stageId: WON, scrollTop: 120 });
    await contains(".o_back_button").click();
    expect(textOf(STAGE_NAME)).toBe("Won");
    // Shown again folded, as the server folds it (its fold state is never changed):
    // its leads are loaded once more, then its offset is applied.
    await waitFor(card("Signed Deal"));
    expect(cardNames()).toInclude("Signed Deal");
    expect(pipelineScroller().scrollTop).toBe(120);
});

test.tags("mobile");
test("mobile pipeline back to a folded stage keeps its leads and scroll offset when the server's answer replaces the cached groups", async () => {
    await makeMockServer();
    addLeads(WON, 20, "Won lead");
    const groupLoads = receivedCalls("crm.lead", "web_search_read");
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(textOf(STAGE_NAME)).toBe("Won");
    await scrollPipeline(120);
    await contains(`${card("Won lead 3")} .o_crm_mobile_lead_open`).click();
    expect(".o_form_view").toHaveCount(1);

    // Meanwhile a lead of "Won" changes on the server. Coming back, the root is
    // first served from the cache; the server's answer, held here, then differs.
    const [wonLead] = MockServer.env["crm.lead"].search([["name", "=", "Won lead 3"]]);
    MockServer.env["crm.lead"].write([wonLead], { expected_revenue: 1000 });
    const rootAnswer = Promise.withResolvers();
    onRpc("crm.lead", "web_read_group", () => rootAnswer.promise);
    await contains(".o_back_button").click();
    expect(textOf(STAGE_NAME)).toBe("Won");
    await waitFor(card("Signed Deal"));
    expect(pipelineScroller().scrollTop).toBe(120);
    expect(groupLoads).toHaveLength(2);

    // The answer replaces the groups of the same root: the folded stage, again
    // without leads, is loaded once more, and shown at the offset it was left at.
    rootAnswer.resolve();
    await waitUntil(() => groupLoads.length === 3);
    await waitFor(card("Signed Deal"));
    expect(groupLoads).toHaveLength(3);
    expect(JSON.stringify(groupLoads.at(-1).kwargs.domain)).toInclude(
        JSON.stringify(["stage_id", "=", WON])
    );
    expect(headerTexts()).toEqual(["Won", "21", "$ 2,090"]);
    expect(cardNames()).toHaveLength(21);
    expect(pipelineScroller().scrollTop).toBe(120);
});

test.tags("mobile");
test("mobile pipeline browser Back returns to the stage and scroll offset it was left at", async () => {
    /** Each pipeline controller created, with the states it was given. */
    const controllers = [];
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controllers.push({ state: this.props.state, globalState: this.props.globalState });
        },
    });
    await makeMockServer();
    addLeads(QUALIFIED, 20, "Qualified lead");
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(".o_crm_mobile_pipeline_next").click();
    await scrollPipeline(150);
    await contains(`${card("Lamps")} .o_crm_mobile_lead_open`).click();
    expect(".o_form_view").toHaveCount(1);

    // The browser's Back: the action service builds a new pipeline controller from
    // the history entry, which holds no local state but the action's global state.
    browser.history.back();
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(controllers.length).toBe(2);
    expect(controllers[1].state).toBe(undefined);
    expect(JSON.parse(controllers[1].globalState.crmMobilePipeline)).toEqual({
        stageId: QUALIFIED,
        scrollTop: 150,
    });
    expect(textOf(STAGE_NAME)).toBe("Qualified");
    expect(cardNames().slice(0, 3)).toEqual(["Conference Room", "Lamps", "Storage Racks"]);
    expect(pipelineScroller().scrollTop).toBe(150);
});

test.tags("mobile");
test("[Offline] mobile pipeline back from a lead returns to the stage it was left at", async () => {
    expect.errors(6);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(".o_crm_mobile_pipeline_next").click();
    await visitLead("Lamps");
    expect(textOf(STAGE_NAME)).toBe("Qualified");
    await contains(".o_crm_mobile_pipeline_next").click();
    await visitLead("Signed Deal");
    expect(textOf(STAGE_NAME)).toBe("Won");

    await setOffline(true);
    const calls = trackCalls();
    // Back button: the pipeline restores its own root, served from the cache. The
    // root request never changes the server's fold state, so the cached root holds
    // no lead of the folded "Won" (they were loaded apart, uncached, when shown
    // online): the stage shown again explains them with the offline helper, and
    // they are not requested.
    await contains(`${card("Signed Deal")} .o_crm_mobile_lead_open`).click();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_back_button").click();
    expect(textOf(STAGE_NAME)).toBe("Won");
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    await contains(".o_crm_mobile_pipeline_prev").click();
    await contains(`${card("Lamps")} .o_crm_mobile_lead_open`).click();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_back_button").click();
    expect(textOf(STAGE_NAME)).toBe("Qualified");
    expect(cardNames()).toEqual(["Conference Room", "Lamps", "Storage Racks"]);

    // Browser Back: a new pipeline, served from the cache.
    await contains(`${card("Lamps")} .o_crm_mobile_lead_open`).click();
    expect(".o_form_view").toHaveCount(1);
    browser.history.back();
    await animationFrame();
    expect(textOf(STAGE_NAME)).toBe("Qualified");
    expect(cardNames()).toEqual(["Conference Room", "Lamps", "Storage Racks"]);
    // Only the framework's cached form and pipeline loads.
    const rootLoads = /^crm\.lead\/(?:web_read|web_read_group|read_progress_bar)$/;
    expect(calls.filter((call) => !rootLoads.test(call))).toEqual([]);
    // The framework's own cached loads offline: each lead form and each pipeline.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("[Offline] mobile pipeline shown again on a stage the cached root did not load shows the offline helper", async () => {
    expect.errors(2);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    await visitLead("Signed Deal");
    expect(textOf(STAGE_NAME)).toBe("Won");

    // Browser Back: a new pipeline loads the cached default root, where the folded
    // "Won" holds no lead. It is shown again with the offline helper, and its leads
    // are not requested.
    await setOffline(true);
    const calls = trackCalls();
    await contains(`${card("Signed Deal")} .o_crm_mobile_lead_open`).click();
    expect(".o_form_view").toHaveCount(1);
    browser.history.back();
    await animationFrame();
    expect(textOf(STAGE_NAME)).toBe("Won");
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    const rootLoads = /^crm\.lead\/(?:web_read|web_read_group|read_progress_bar)$/;
    expect(calls.filter((call) => !rootLoads.test(call))).toEqual([]);
    // The framework's own cached loads offline: the lead form and the pipeline.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile pipeline shows the first stage when the stage it was left at is gone or unreadable", async () => {
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(`${card("Lamps")} .o_crm_mobile_lead_open`).click();
    // Meanwhile, every lead of "Qualified" is won: the pipeline has no such stage.
    MockServer.env["crm.lead"].write([4, 5, 6], { stage_id: WON });
    await contains(".o_back_button").click();
    expect(queryAllTexts(".o_crm_mobile_pipeline_stage_name")).toEqual(["New"]);
    expect(".o_crm_mobile_pipeline_prev").toHaveAttribute("disabled");
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);

    // A global state naming no stage of the pipeline, or not readable.
    for (const value of [
        JSON.stringify({ stageId: 999, scrollTop: 40 }),
        JSON.stringify({ stageId: String(WON), scrollTop: 40 }),
        JSON.stringify({ scrollTop: 40 }),
        "null",
        "{",
        42,
    ]) {
        await getService("action").doAction(ACTION_ID, {
            clearBreadcrumbs: true,
            props: { globalState: { crmMobilePipeline: value } },
        });
        expect(textOf(STAGE_NAME)).toBe("New");
        expect(pipelineScroller().scrollTop).toBe(0);
    }
    // One naming a stage of the pipeline shows it.
    await getService("action").doAction(ACTION_ID, {
        clearBreadcrumbs: true,
        props: { globalState: { crmMobilePipeline: JSON.stringify({ stageId: WON }) } },
    });
    expect(textOf(STAGE_NAME)).toBe("Won");
});

test.tags("mobile");
test("mobile pipeline opened anew from the menu shows its first stage", async () => {
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(`${card("Lamps")} .o_crm_mobile_lead_open`).click();
    expect(exportedPipelineState()).toEqual({ stageId: QUALIFIED, scrollTop: 0 });

    // A menu entry opens its action as a new breadcrumb root.
    await openAction(ACTION_ID);
    expect(textOf(STAGE_NAME)).toBe("New");
    await contains(".o_crm_mobile_pipeline_next").click();
    await openAction(ACTION_ID);
    expect(textOf(STAGE_NAME)).toBe("New");
});

test.tags("mobile");
test("mobile pipeline shows another stage from its first card", async () => {
    await makeMockServer();
    addLeads(NEW, 20, "New lead");
    addLeads(QUALIFIED, 20, "Qualified lead");
    addLeads(WON, 20, "Won lead");
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    /** Asserts the stage shown, at the top of cards that overflow the content area. */
    const expectStageAtTop = (name) => {
        expect(textOf(STAGE_NAME)).toBe(name);
        const scroller = pipelineScroller();
        expect(scroller.scrollHeight - scroller.clientHeight).toBeGreaterThan(150);
        expect(scroller.scrollTop).toBe(0);
    };

    // A swipe towards no stage changes nothing.
    await scrollPipeline(150);
    await swipe(120);
    expect(textOf(STAGE_NAME)).toBe("New");
    expect(pipelineScroller().scrollTop).toBe(150);

    // Next and previous, by button and by swipe.
    await contains(".o_crm_mobile_pipeline_next").click();
    expectStageAtTop("Qualified");
    await scrollPipeline(150);
    await contains(".o_crm_mobile_pipeline_prev").click();
    expectStageAtTop("New");
    await scrollPipeline(150);
    await swipe(-120);
    expectStageAtTop("Qualified");
    await scrollPipeline(150);
    await swipe(120);
    expectStageAtTop("New");

    // The folded last stage, loaded when reached; then no stage after it.
    await contains(".o_crm_mobile_pipeline_next").click();
    await scrollPipeline(150);
    await swipe(-120);
    expectStageAtTop("Won");
    await scrollPipeline(100);
    await swipe(-120);
    expect(textOf(STAGE_NAME)).toBe("Won");
    expect(pipelineScroller().scrollTop).toBe(100);

    // A lead created in another stage shows that stage.
    await quickCreateLead({ name: "Quick Lead", stageId: NEW });
    await animationFrame();
    expectStageAtTop("New");
    expect(cardNames()).toInclude("Quick Lead");
});

test.tags("mobile");
test("mobile pipeline Load more counts the leads left to load, a filtered 0 included", async () => {
    let holdGroupLoads = null;
    onRpc("crm.lead", "web_search_read", () => holdGroupLoads?.promise);
    await mountWithCleanup(WebClient);
    // Two leads loaded per stage: one of the three "New" leads is left to load.
    await openAction(LIMITED_ACTION_ID);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);
    expect(textOf(".o_crm_mobile_pipeline_load_more button")).toBe("Load more... (1 remaining)");

    // A progress-bar filter selected on a wide screen: its only lead is loaded.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    await contains(".o_kanban_group:first .progress-bar.bg-success").click();
    expect(".o_kanban_group:first .o_kanban_record").toHaveCount(1);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "1", null]);
    expect(cardNames()).toEqual(["Office Design"]);
    expect(".o_crm_mobile_pipeline_load_more").toHaveCount(0);

    // That lead leaves the filter on the server: after a reload the active bar counts
    // 0 until the framework drops the empty filter (its group reload is held here).
    // Nothing is left to load, whatever the unfiltered count of the stage.
    MockServer.env["crm.lead"].write([1], { activity_state: false });
    holdGroupLoads = Promise.withResolvers();
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "0", null]);
    expect(cardNames()).toEqual([]);
    expect(".o_crm_mobile_pipeline_load_more").toHaveCount(0);

    // Filter dropped: the unfiltered stage, with one lead left to load again.
    holdGroupLoads.resolve();
    holdGroupLoads = null;
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);
    expect(textOf(".o_crm_mobile_pipeline_load_more button")).toBe("Load more... (1 remaining)");
});

test.tags("mobile");
test("mobile pipeline Load more is disabled and busy while it loads, and loads once", async () => {
    // Five "New" leads, two more loaded by each "Load more".
    await makeMockServer();
    MockServer.env["crm.lead"].create([
        { name: "Printer Lease", stage_id: NEW, expected_revenue: 10, team_id: 1 },
        { name: "Phone Lines", stage_id: NEW, expected_revenue: 20, team_id: 1 },
    ]);
    let holdLoadMore = null;
    const loadLimits = [];
    onRpc("crm.lead", "web_search_read", ({ kwargs }) => {
        loadLimits.push(kwargs.limit);
        return holdLoadMore?.promise;
    });
    await mountWithCleanup(WebClient);
    await openAction(LIMITED_ACTION_ID);
    const button = ".o_crm_mobile_pipeline_load_more button";
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);
    expect(textOf(button)).toBe("Load more... (3 remaining)");
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(`${button} .fa-spin`).toHaveCount(0);

    // Two clicks before the next render: one load. Until it ends, the button is
    // disabled, busy and shows the framework spinner, and a click does nothing.
    holdLoadMore = Promise.withResolvers();
    queryFirst(button).click();
    queryFirst(button).click();
    await animationFrame();
    expect(loadLimits).toEqual([4]);
    expect(button).not.toBeEnabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(`${button} .fa-circle-o-notch.fa-spin[aria-hidden=true]`).toHaveCount(1);
    expect(textOf(button)).toBe("Load more... (3 remaining)");
    queryFirst(button).click();
    await animationFrame();
    expect(loadLimits).toEqual([4]);

    // Loaded: the new cards, and the button ready for the rest.
    holdLoadMore.resolve();
    holdLoadMore = null;
    await animationFrame();
    expect(cardNames()).toEqual([
        "Office Design",
        "Quote for Chairs",
        "Desk Upgrade",
        "Printer Lease",
    ]);
    expect(textOf(button)).toBe("Load more... (1 remaining)");
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(`${button} .fa-spin`).toHaveCount(0);
    expect(loadLimits).toEqual([4]);

    // The last lead: nothing is left to load, the button goes.
    await contains(button).click();
    expect(loadLimits).toEqual([4, 6]);
    expect(cardNames()).toEqual([
        "Office Design",
        "Quote for Chairs",
        "Desk Upgrade",
        "Printer Lease",
        "Phone Lines",
    ]);
    expect(".o_crm_mobile_pipeline_load_more").toHaveCount(0);
});

test.tags("mobile");
test("mobile pipeline Load more ends its busy state when the load fails", async () => {
    expect.errors(1);
    let failLoadMore = false;
    onRpc("crm.lead", "web_search_read", () => {
        if (failLoadMore) {
            failLoadMore = false;
            throw makeServerError({ message: "Load more failed" });
        }
    });
    await mountWithCleanup(WebClient);
    await openAction(LIMITED_ACTION_ID);
    const button = ".o_crm_mobile_pipeline_load_more button";

    // The server rejects the load: the error reaches the framework's error handling,
    // the stage keeps its cards and the button is ready again.
    failLoadMore = true;
    await contains(button).click();
    await animationFrame();
    expect(failLoadMore).toBe(false);
    expect.verifyErrors(["Load more failed"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);
    expect(textOf(button)).toBe("Load more... (1 remaining)");
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(`${button} .fa-spin`).toHaveCount(0);

    // A retry loads the last lead.
    await contains(button).click();
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(".o_crm_mobile_pipeline_load_more").toHaveCount(0);
});

test.tags("mobile");
test("mobile pipeline renders a cached stage offline", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    // Online visit of every stage: the folded "Won" stage is loaded when reached.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(cardNames()).toEqual(["Signed Deal"]);
    await contains(".o_crm_mobile_pipeline_prev").click();
    await contains(".o_crm_mobile_pipeline_prev").click();

    await setOffline(true);
    const calls = trackCalls();
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
    expect(cardNames()).toEqual(["Conference Room", "Lamps", "Storage Racks"]);
    // The folded stage keeps the leads loaded before: its cards render offline.
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Won", "1", "$ 900"]);
    expect(cardNames()).toEqual(["Signed Deal"]);
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(0);
    expect(calls).toEqual([]);
});

test.tags("mobile");
test("mobile pipeline shows offline action helper for an uncached stage", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    const calls = trackCalls();

    // "Won" is folded: its leads were never loaded.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Won", "1", "$ 900"]);
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    expect(".o_crm_mobile_pipeline_body").toHaveText(/There is no data to display offline/);
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(calls).toEqual([]);

    // A loaded stage still renders its cards.
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(cardNames()).toEqual(["Conference Room", "Lamps", "Storage Racks"]);
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(0);
    expect(calls).toEqual([]);
});

/** Helper of a stage whose leads are not loaded offline (not the whole pipeline's). */
const STAGE_HELPER = ".o_crm_mobile_pipeline_body .o_view_nocontent";

test.tags("mobile");
test("mobile pipeline loads a folded stage reached offline once the connection returns", async () => {
    const setOffline = mockOffline();
    const groupLoads = receivedCalls("crm.lead", "web_search_read");
    await mountPipeline();
    await setOffline(true);
    const calls = trackCalls();

    // Offline, the folded "Won" stage, never loaded: its helper, and no request.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Won", "1", "$ 900"]);
    expect(STAGE_HELPER).toHaveCount(1);
    expect(calls).toEqual([]);

    // Reconnected on that stage: one request loads its leads, and its card renders.
    await setOffline(false);
    await animationFrame();
    expect(calls).toEqual(["crm.lead/web_search_read"]);
    expect(JSON.stringify(groupLoads.at(-1).kwargs.domain)).toInclude(
        JSON.stringify(["stage_id", "=", WON])
    );
    expect(headerTexts()).toEqual(["Won", "1", "$ 900"]);
    expect(cardNames()).toEqual(["Signed Deal"]);
    expect(STAGE_HELPER).toHaveCount(0);
    expect(".o_crm_mobile_pipeline_load_more").toHaveCount(0);

    // Leaving the stage and coming back online sends no other request.
    await contains(".o_crm_mobile_pipeline_prev").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(cardNames()).toEqual(["Signed Deal"]);
    expect(calls).toEqual(["crm.lead/web_search_read"]);
});

test.tags("mobile");
test("mobile pipeline keeps the root request of a folded stage reached online, and reloads it from the cache offline", async () => {
    expect.errors(1);
    let controller = null;
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    const setOffline = mockOffline();
    const rootLoads = receivedCalls("crm.lead", "web_read_group");
    await mountPipeline();
    const calls = trackCalls();

    // Online, the folded "Won" stage loads its leads when reached, with one request.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(cardNames()).toEqual(["Signed Deal"]);
    expect(calls).toEqual(["crm.lead/web_search_read"]);
    const won = controller.model.root.groups.find((group) => group.value === WON);
    expect(won.isFolded).toBe(true);

    // The next root request is the first one: no opening info, no fold state changed.
    await contains(".o_crm_mobile_pipeline_prev").click();
    await contains(".o_crm_mobile_pipeline_prev").click();
    await controller.model.load();
    await animationFrame();
    expect(rootLoads).toHaveLength(2);
    expect(rootLoads[1].kwargs).toEqual(rootLoads[0].kwargs);
    expect(rootLoads[1].kwargs).not.toInclude("opening_info");

    // Offline, a root reload is served from the cache: the header, the stages and
    // their cards, with no helper of the whole pipeline.
    await setOffline(true);
    await controller.model.load();
    await animationFrame();
    expect(controller.model.couldNotLoadRootOffline).toBe(false);
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(".o_view_nocontent").toHaveCount(0);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
    expect(cardNames()).toEqual(["Conference Room", "Lamps", "Storage Racks"]);
    // Only the framework's cached root load, served offline.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

test.tags("mobile");
test("mobile pipeline is served from the cache after a form round trip offline once a never-loaded folded stage was reached offline", async () => {
    expect.errors(2);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await visitLead("Office Design");
    await setOffline(true);
    const calls = trackCalls();

    // Offline, the folded "Won" stage, never loaded: its helper, and no request.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Won", "1", "$ 900"]);
    expect(STAGE_HELPER).toHaveCount(1);
    expect(calls).toEqual([]);

    // Back from a cached lead form, the root reload is served from the cache: the
    // header, the stages and their cards, with no helper of the whole pipeline.
    await contains(".o_crm_mobile_pipeline_prev").click();
    await contains(".o_crm_mobile_pipeline_prev").click();
    await visitLead("Office Design");
    expect(".o_view_nocontent").toHaveCount(0);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
    expect(cardNames()).toEqual(["Conference Room", "Lamps", "Storage Racks"]);
    // Only the framework's cached form and root loads, served offline.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile pipeline leaves a folded stage visited on a phone folded on a wide screen", async () => {
    const rootLoads = receivedCalls("crm.lead", "web_read_group");
    await mountPipeline();
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(cardNames()).toEqual(["Signed Deal"]);

    // Widened: the desktop kanban shows "Won" folded, as the server folds it.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_group").toHaveCount(3);
    expect(".o_kanban_group.o_column_folded").toHaveCount(1);
    expect(".o_kanban_group.o_column_folded").toHaveText(/Won/);
    expect(rootLoads.at(-1).kwargs).not.toInclude("opening_info");
});

/**
 * Opens the pipeline loading two leads per stage, visits "Office Design" (its form
 * and the pipeline's root request without opening info are cached), then loads the
 * third lead of "New" with "Load more": from then on, the root requests send the
 * opening info of every stage, which keeps that lead loaded.
 */
async function loadMoreAfterVisit() {
    await mountWithCleanup(WebClient);
    await openAction(LIMITED_ACTION_ID);
    await visitLead("Office Design");
    await contains(".o_crm_mobile_pipeline_load_more button").click();
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
}

test.tags("mobile");
test("mobile pipeline is served from the cache after a form round trip offline once Load more was used online", async () => {
    expect.errors(2);
    const setOffline = mockOffline();
    const requests = rootRequests();
    await loadMoreAfterVisit();
    expect(requests).toEqual([
        [false, true],
        [false, true],
    ]);

    await setOffline(true);
    const calls = trackCalls();
    // Back from the cached lead form, the request with opening info is not cached:
    // the root is read again without it, which the cache serves. The header, the
    // stages and their cached cards show, with no helper of the whole pipeline.
    await visitLead("Office Design");
    expect(requests.slice(2)).toEqual([
        [true, true],
        [false, true],
    ]);
    expect(".o_view_nocontent").toHaveCount(0);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
    expect(cardNames()).toEqual(["Conference Room", "Lamps"]);
    const rootLoads = /^crm\.lead\/(?:web_read|web_read_group|read_progress_bar)$/;
    expect(calls.filter((call) => !rootLoads.test(call))).toEqual([]);

    // Reconnected: "New" offers its third lead again, and the next root request sends
    // the opening info again, which loads it as before the disconnection.
    await setOffline(false);
    await animationFrame();
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(textOf(".o_crm_mobile_pipeline_load_more button")).toBe("Load more... (1 remaining)");
    await visitLead("Office Design");
    expect(requests.slice(4)).toEqual([[true, true]]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    // Only the framework's cached form and root loads, served offline.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile pipeline whose root is not cached offline loads it once the connection returns", async () => {
    expect.errors(2);
    let rpcCache = null;
    const { setCache } = rpc;
    patchWithCleanup(rpc, {
        setCache(cache) {
            rpcCache = cache;
            return setCache.call(this, cache);
        },
    });
    const setOffline = mockOffline();
    const requests = rootRequests();
    await loadMoreAfterVisit();

    // Offline, the cache no longer holds any root request of the pipeline: back from
    // the cached lead form, each variant is read with and without opening info, then
    // the framework's offline helper replaces the pipeline.
    await setOffline(true);
    rpcCache.invalidate("web_read_group");
    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_back_button").click();
    await animationFrame();
    expect(requests.slice(2)).toEqual([
        [true, true],
        [false, true],
        [true, false],
        [false, false],
    ]);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_view .o_view_nocontent .fa-chain-broken").toHaveCount(1);

    // Reconnected: the root is loaded with the mobile variant and the opening info,
    // and the pipeline replaces the helper, with the lead "Load more" had loaded.
    await setOffline(false);
    await animationFrame();
    await animationFrame();
    expect(requests.slice(6)).toEqual([[true, true]]);
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(".o_view_nocontent").toHaveCount(0);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    // The framework's cached form load offline, and its root load that could not be
    // served.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

/** Search of the empty-pipeline tests: no lead matches it until "Offline Lead" is created. */
const OFFLINE_LEAD_DOMAIN = [["name", "=", "Offline Lead"]];

/** The framework's empty-data helper of the whole pipeline (not a stage helper). */
const ROOT_HELPER = ".o_crm_mobile_pipeline > .o_view_nocontent";

/**
 * Lists every stage in the grouped lead loads, as the server's `stage_id` group
 * expansion does (the mock server has none): a search matching no lead still
 * returns each stage, with a count of 0, `false` aggregates and, when unfolded,
 * no records.
 */
function expandStageGroups() {
    onRpc("crm.lead", "web_read_group", async function ({ kwargs, parent }) {
        const result = await parent();
        if (kwargs.groupby[0] !== "stage_id") {
            return result;
        }
        const openingInfo = kwargs.opening_info || [];
        const stageGroups = this.env["crm.stage"].search_read([], ["name", "fold"]).map((stage) => {
            const group = result.groups.find(({ stage_id }) => stage_id?.[0] === stage.id);
            if (group) {
                return group;
            }
            const empty = {
                stage_id: [stage.id, stage.name],
                __extra_domain: [["stage_id", "=", stage.id]],
                __count: 0,
                __fold: stage.fold,
                ...Object.fromEntries(kwargs.aggregates.map((spec) => [spec, false])),
            };
            const info = openingInfo.find(({ value }) => value === stage.id);
            if (info ? !info.folded : kwargs.auto_unfold && !stage.fold) {
                empty.__records = [];
            }
            return empty;
        });
        const groups = [...result.groups.filter(({ stage_id }) => !stage_id), ...stageGroups];
        return { groups, length: groups.length };
    });
}

test.tags("mobile");
test("mobile pipeline hides the empty-data helper while a provisional card shows", async () => {
    expect.errors(1);
    expandStageGroups();
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    // Online, a search no lead matches: the stages are listed, empty, with the helper.
    await getService("action").doAction(
        {
            type: "ir.actions.act_window",
            res_model: "crm.lead",
            views: [
                [false, "kanban"],
                [false, "form"],
            ],
            domain: OFFLINE_LEAD_DOMAIN,
            context: PIPELINE_CONTEXT,
            // Data caching on, as the server's window actions default to.
            cache: true,
        },
        { clearBreadcrumbs: true }
    );
    expect(".o_view_sample_data").toHaveCount(0);
    // No lead is loaded: the revenue is in the company currency.
    expect(headerTexts()).toEqual(["New", "0", "$ 0"]);
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(ROOT_HELPER).toHaveCount(1);
    expect(ROOT_HELPER).toHaveText(/No data to display/);

    // Offline create: the provisional card shows without the helper, in every stage.
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    expect(cardNames()).toEqual(["Offline Lead"]);
    expect(".o_crm_mobile_lead_card_provisional").toHaveCount(1);
    expect(headerTexts()).toEqual(["New", "1", "$ 50"]);
    expect(".o_view_nocontent").toHaveCount(0);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "0", "$ 0"]);
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(".o_view_nocontent").toHaveCount(0);
    await contains(".o_crm_mobile_pipeline_prev").click();

    // Discarded in the offline systray: empty again (cached reload), with the helper.
    await contains("div.o_nav_entry.o_offline_systray").click();
    await contains(".o-dropdown--menu button[title='Discard offline changes']").click();
    await contains(".modal-dialog .modal-footer button.btn-primary").click();
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(headerTexts()).toEqual(["New", "0", "$ 0"]);
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(ROOT_HELPER).toHaveCount(1);

    // Created again, then replayed: the server card replaces the provisional one.
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    expect(cardNames()).toEqual(["Offline Lead"]);
    expect(".o_view_nocontent").toHaveCount(0);
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(cardNames()).toEqual(["Offline Lead"]);
    expect(".o_crm_mobile_pending_sync").toHaveCount(0);
    expect(headerTexts()).toEqual(["New", "1", "$ 50"]);
    expect(".o_view_nocontent").toHaveCount(0);
    expect(MockServer.env["crm.lead"].search_read(OFFLINE_LEAD_DOMAIN, ["stage_id"])).toEqual([
        { id: 8, stage_id: [NEW, "New"] },
    ]);
    // The framework's own cached root load offline: the reload after the discard.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

test.tags("mobile");
test("mobile quick create leaves the sample data of an empty pipeline", async () => {
    expandStageGroups();
    const setOffline = mockOffline();
    await mountPipeline({
        arch: pipelineArch.replace("<kanban ", '<kanban sample="1" '),
        domain: OFFLINE_LEAD_DOMAIN,
    });
    // Online, nothing matches: sample cards under the sample helper.
    expect(".o_view_sample_data").toHaveCount(1);
    expect(".o_crm_mobile_lead_card").not.toHaveCount(0);
    expect(ROOT_HELPER).toHaveCount(1);

    // Offline create: the sample data leaves when the sheet opens, as in the
    // framework's quick create, so the provisional card shows alone.
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    expect(".o_view_sample_data").toHaveCount(0);
    expect(cardNames()).toEqual(["Offline Lead"]);
    // The sample sums left with the sample data: the stage sums its offline create only.
    expect(headerTexts()).toEqual(["New", "1", "$ 50"]);
    expect(".o_view_nocontent").toHaveCount(0);
    expect(".o_crm_mobile_lead_card_provisional").toHaveCount(1);
    expect(queued("crm.lead").map(({ method, args }) => ({ method, args }))).toEqual([
        {
            method: "web_save",
            args: [
                [],
                {
                    name: "Offline Lead",
                    contact_name: false,
                    phone: false,
                    email_from: false,
                    expected_revenue: 50,
                    stage_id: NEW,
                },
            ],
        },
    ]);
});

test.tags("mobile");
test("mobile pipeline shows offline action helper for an uncached lead", async () => {
    const setOffline = mockOffline();
    await mountPipeline({ selectRecord: (resId) => expect.step(`open ${resId}`) });
    // Online, every lead opens.
    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();
    expect.verifySteps(["open 1"]);

    // Offline, a lead whose form was never visited shows the framework helper.
    await setOffline(true);
    const calls = trackCalls();
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_open`).click();
    expect.verifySteps([]);
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(".o_form_view").toHaveCount(0);
    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    expect(calls).toEqual([]);

    // Its back button leaves the helper.
    await contains(".o_crm_mobile_pipeline_helper_back").click();
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(0);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(calls).toEqual([]);
});

test.tags("mobile");
test("mobile pipeline stage name is a level-2 heading that announces the stage", async () => {
    await mountPipeline();
    const name = ".o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_stage_name";
    expect(name).toHaveCount(1);
    expect(name).toHaveAttribute("role", "heading");
    expect(name).toHaveAttribute("aria-level", "2");
    expect(name).toHaveAttribute("aria-live", "polite");
    expect(name).toHaveClass("fw-bold");
    expect(name).toHaveText("New");
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(name).toHaveAttribute("role", "heading");
    expect(name).toHaveText("Qualified");
});

/** Skip link of the displayed cards, and the end marker after the last card it focuses. */
const SKIP_LINK = ".o_crm_mobile_pipeline_body > .o_crm_mobile_pipeline_skip";
const CARDS_END = ".o_crm_mobile_pipeline_body > .o_crm_mobile_pipeline_end";

/**
 * The tabbable elements around `target` in sequential focus order: Shift+Tab
 * reaches `previous` from it and Tab `next`. Hoot moves the focus by Tab only from
 * a tabbable element, which the end marker (`tabindex="-1"`) is not, while a
 * browser starts from the focused element whatever its tab index.
 *
 * @param {HTMLElement} target
 * @returns {{previous: HTMLElement|null, next: HTMLElement|null}}
 */
function tabNeighbours(target) {
    const tabbables = getFocusableElements({ tabbable: true });
    const follows = (a, b) =>
        Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
        previous: tabbables.filter((el) => follows(el, target)).at(-1) || null,
        next: tabbables.find((el) => follows(target, el)) || null,
    };
}

/**
 * Activates the skip link from the keyboard: Tab from the control before it, then
 * Enter, which the browser turns into a click.
 *
 * @param {string} previousSelector the tabbable control right before the skip link
 */
async function skipCardsByKeyboard(previousSelector) {
    queryFirst(previousSelector).focus();
    await press("Tab");
    expect(SKIP_LINK).toBeFocused();
    await press("Enter");
    expect(CARDS_END).toBeFocused();
}

test.tags("mobile");
test("mobile pipeline skip link takes the focus past the stage's cards, before Load more", async () => {
    // Two of the three "New" leads loaded: "Load more" follows the cards.
    await mountPipeline({ arch: limitedPipelineArch });
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);
    const body = queryFirst(".o_crm_mobile_pipeline_body");
    const cards = queryAll(".o_crm_mobile_pipeline_body > .o_crm_mobile_lead_card");
    const loadMore = queryFirst(".o_crm_mobile_pipeline_load_more");

    // The skip link opens the body, usable offline; the end marker follows the last
    // card, before "Load more", out of the tab order.
    expect(SKIP_LINK).toHaveCount(1);
    expect(body.firstElementChild).toBe(queryFirst(SKIP_LINK));
    expect(SKIP_LINK).toHaveAttribute("type", "button");
    expect(SKIP_LINK).toHaveAttribute("data-available-offline", "1");
    expect(SKIP_LINK).toHaveClass("visually-hidden-focusable");
    expect(SKIP_LINK).toHaveText("Skip to the end of the leads");
    expect(CARDS_END).toHaveCount(1);
    const end = queryFirst(CARDS_END);
    expect(end.previousElementSibling).toBe(cards.at(-1));
    expect(end.nextElementSibling).toBe(loadMore);
    expect(end).toHaveAttribute("tabindex", "-1");
    expect(end).toHaveClass("visually-hidden-focusable");
    expect(end).toHaveText("End of the leads");
    // No new control in the cards (three each).
    expect(".o_crm_mobile_lead_card :is(a, button, input, select, textarea)").toHaveCount(6);

    // Unfocused, both are hidden out of the body's flex flow: they add no gap before
    // the first card or after the last one. The first card sits where the body's
    // padding and its own margin put it (it shares the header's bottom border), and
    // "Load more" follows the last card by the body's row gap and their margins
    // alone (a flex column's `normal` row gap is none).
    expect(SKIP_LINK).toHaveStyle({ position: "absolute" });
    expect(CARDS_END).toHaveStyle({ position: "absolute" });
    const px = (value) => parseFloat(value) || 0;
    const { paddingTop, rowGap } = getComputedStyle(body);
    expect(
        Math.round(cards[0].getBoundingClientRect().top - body.getBoundingClientRect().top)
    ).toBe(Math.round(px(paddingTop) + px(getComputedStyle(cards[0]).marginTop)));
    expect(
        Math.round(
            loadMore.getBoundingClientRect().top - cards.at(-1).getBoundingClientRect().bottom
        )
    ).toBe(
        Math.round(
            px(rowGap) +
                px(getComputedStyle(cards.at(-1)).marginBottom) +
                px(getComputedStyle(loadMore).marginTop)
        )
    );

    // Tab from the header's last control reaches the skip link, shown as a touch
    // target of at least 44 x 44 px.
    queryFirst(".o_crm_mobile_pipeline_new").focus();
    await press("Tab");
    expect(SKIP_LINK).toBeFocused();
    expect(SKIP_LINK).not.toHaveStyle({ position: "absolute" });
    const { width, height } = queryFirst(SKIP_LINK).getBoundingClientRect();
    expect(width >= TOUCH_TARGET && height >= TOUCH_TARGET).toBe(true, {
        message: `skip link: ${width} x ${height}`,
    });

    // Enter focuses the end marker, shown with a focus ring; the skip link hides again.
    await press("Enter");
    expect(CARDS_END).toBeFocused();
    expect(CARDS_END).not.toHaveStyle({ position: "absolute" });
    expect(CARDS_END).not.toHaveStyle({ boxShadow: "none" });
    // The ring (4 px) is not cut by the body's clipped side edges.
    const endRect = queryFirst(CARDS_END).getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const insets = [endRect.left - bodyRect.left, bodyRect.right - endRect.right];
    expect(insets.every((inset) => inset >= 4)).toBe(true, {
        message: `end marker insets: ${insets}`,
    });
    expect(SKIP_LINK).toHaveStyle({ position: "absolute" });
    // From there, Tab reaches "Load more" and Shift+Tab the last card.
    const { previous, next } = tabNeighbours(end);
    expect(next).toBe(queryFirst(".o_crm_mobile_pipeline_load_more button"));
    expect(cards.at(-1).contains(previous)).toBe(true, { message: previous?.className });

    // Once "Load more" brought the last lead, the marker follows its card and ends
    // the body; activating the skip link (as assistive technology does) focuses it.
    await contains(".o_crm_mobile_pipeline_load_more button").click();
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(".o_crm_mobile_pipeline_load_more").toHaveCount(0);
    expect(queryFirst(CARDS_END).previousElementSibling).toBe(
        queryAll(".o_crm_mobile_lead_card").at(-1)
    );
    expect(body.lastElementChild).toBe(queryFirst(CARDS_END));
    queryFirst(SKIP_LINK).click();
    expect(CARDS_END).toBeFocused();
});

test.tags("mobile");
test("mobile pipeline skip link is shown with cards only and works offline", async () => {
    expandStageGroups();
    const setOffline = mockOffline();
    // The won stage's only lead is filtered out: that stage shows no card.
    await mountPipeline({ domain: [["name", "!=", "Signed Deal"]] });
    expect(SKIP_LINK).toHaveCount(1);

    // Offline, the skip link stays enabled and moves the focus.
    await setOffline(true);
    expect(SKIP_LINK).toBeEnabled();
    expect(SKIP_LINK).not.toHaveClass("o_disabled_offline");
    await skipCardsByKeyboard(".o_crm_mobile_pipeline_new");
    expect(queryFirst(CARDS_END).previousElementSibling).toBe(
        queryAll(".o_crm_mobile_lead_card").at(-1)
    );

    // The uncached-lead helper replaces the cards, and both with them.
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_open`).click();
    expect(".o_crm_mobile_pipeline_helper_back").toBeFocused();
    expect(SKIP_LINK).toHaveCount(0);
    expect(CARDS_END).toHaveCount(0);
    await contains(".o_crm_mobile_pipeline_helper_back").click();
    expect(SKIP_LINK).toHaveCount(1);
    expect(CARDS_END).toHaveCount(1);

    // A stage without cards has neither.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Won");
    expect(textOf(".o_crm_mobile_pipeline_count")).toBe("0");
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(SKIP_LINK).toHaveCount(0);
    expect(CARDS_END).toHaveCount(0);

    // A lead created there offline brings both, around its provisional card.
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    expect(cardNames()).toEqual(["Offline Lead"]);
    expect(SKIP_LINK).toHaveCount(1);
    expect(SKIP_LINK).toBeEnabled();
    expect(queryFirst(CARDS_END).previousElementSibling).toBe(
        queryFirst(".o_crm_mobile_lead_card_provisional")
    );
    await skipCardsByKeyboard(".o_crm_mobile_pipeline_new");
});

test.tags("mobile");
test("mobile pipeline skip link of an ungrouped list takes the focus past its cards", async () => {
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    const body = queryFirst(".o_crm_mobile_pipeline_body");
    const cards = queryAll(".o_crm_mobile_pipeline_body > .o_crm_mobile_lead_card");
    expect(cards).toHaveLength(7);
    expect(body.firstElementChild).toBe(queryFirst(SKIP_LINK));
    expect(SKIP_LINK).toHaveAttribute("data-available-offline", "1");
    expect(SKIP_LINK).toHaveText("Skip to the end of the leads");
    expect(body.lastElementChild).toBe(queryFirst(CARDS_END));
    expect(queryFirst(CARDS_END).previousElementSibling).toBe(cards.at(-1));
    expect(CARDS_END).toHaveAttribute("tabindex", "-1");
    expect(SKIP_LINK).toHaveStyle({ position: "absolute" });
    expect(CARDS_END).toHaveStyle({ position: "absolute" });

    // The first tabbable control of the body: reached by Tab from the one before it.
    const { previous } = tabNeighbours(queryFirst(SKIP_LINK));
    expect(previous).not.toBe(null);
    previous.focus();
    await press("Tab");
    expect(SKIP_LINK).toBeFocused();
    const { width, height } = queryFirst(SKIP_LINK).getBoundingClientRect();
    expect(width >= TOUCH_TARGET && height >= TOUCH_TARGET).toBe(true, {
        message: `skip link: ${width} x ${height}`,
    });
    await press("Enter");
    expect(CARDS_END).toBeFocused();
    expect(CARDS_END).not.toHaveStyle({ position: "absolute" });
    expect(cards.at(-1).contains(tabNeighbours(queryFirst(CARDS_END)).previous)).toBe(true);
});

test.tags("mobile");
test("mobile pipeline renders no skip link for an empty ungrouped list", async () => {
    await mountPipeline({ arch: leadsArch, groupBy: [], domain: [["id", "<", 0]] });
    expect(".o_crm_mobile_pipeline_body").toHaveCount(1);
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(SKIP_LINK).toHaveCount(0);
    expect(CARDS_END).toHaveCount(0);
});

/** The visually hidden status region of the mobile stage header. */
const HEADER_STATUS = ".o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_status";

test.tags("mobile");
test("mobile pipeline status region reads out the final stage count and revenue", async () => {
    // The revenue animates here: the region gives its final value at once.
    patchWithCleanup(AnimatedNumber, { enableAnimations: true });
    const setOffline = mockOffline();
    await mountPipeline();
    expect(HEADER_STATUS).toHaveCount(1);
    expect(HEADER_STATUS).toHaveAttribute("role", "status");
    expect(HEADER_STATUS).toHaveAttribute("aria-atomic", "true");
    expect(HEADER_STATUS).toHaveClass("visually-hidden");
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 3, expected revenue: $ 600");
    // The visible count and the animated revenue are in no live region.
    for (const selector of [
        ".o_crm_mobile_pipeline_count",
        ".o_crm_mobile_pipeline_revenue .o_animated_number",
    ]) {
        expect(queryFirst(selector).closest("[aria-live], [role=status]")).toBe(null);
    }

    // Offline quick create: the final values while the revenue still animates.
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    expect(textOf(HEADER_STATUS)).toBe("Leads: 4, expected revenue: $ 650");
    expect(textOf(".o_crm_mobile_pipeline_revenue")).not.toBe("$ 650");
    await advanceTime(1000);
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "4", "$ 650"]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 4, expected revenue: $ 650");

    // Another stage: its own values.
    await contains(".o_crm_mobile_pipeline_next").click();
    await advanceTime(1000);
    await animationFrame();
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 3, expected revenue: $ 700");
});

test.tags("mobile");
test("mobile pipeline status region leaves out the revenue the header omits", async () => {
    expect.errors(1);
    expandStageGroups();
    const setOffline = mockOffline();
    // The Leads arch visited online at desktop size only, without the won stage's lead.
    await resize({ width: 1366, height: 768 });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(
        {
            type: "ir.actions.act_window",
            res_model: "crm.lead",
            views: [
                [LEADS_VIEW_ID, "kanban"],
                [false, "form"],
            ],
            domain: [["name", "!=", "Signed Deal"]],
            context: { group_by: ["stage_id"] },
            cache: true,
        },
        { clearBreadcrumbs: true }
    );
    expect(".o_kanban_group").toHaveCount(3);

    // Offline on a small screen: served the desktop variant, which aggregates no
    // revenue. Neither the header nor its status shows one, and an offline create
    // adds none, also in the stage without leads.
    await setOffline(true);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "3", null]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 3");
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    expect(headerTexts()).toEqual(["New", "4", null]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 4");
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Won", "0", null]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 0");
    await quickCreateLead({ name: "Won Lead", revenue: 70 });
    expect(cardNames()).toEqual(["Won Lead"]);
    expect(headerTexts()).toEqual(["Won", "1", null]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 1");
    // Only the framework's cached root load (the desktop variant, served offline).
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

test.tags("mobile");
test("mobile pipeline header follows offline moves out of and into stages filtered by a progress bar", async () => {
    onRpc("crm.lead", "get_rainbowman_message", () => false);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    // Two planned leads in "New".
    MockServer.env["crm.lead"].write([2], { activity_state: "planned" });

    // A progress-bar filter selected on a wide screen stays active on the phone.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    await contains(".o_kanban_group:first .progress-bar.bg-success").click();
    expect(".o_kanban_group:first .o_kanban_record").toHaveCount(2);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "2", null]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);

    // Online, a move out is counted once: the save refreshes the server's bar count.
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_stage`).select(
        String(QUALIFIED)
    );
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "1", null]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 1");
    expect(cardNames()).toEqual(["Office Design"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 900"]);
    await contains(".o_crm_mobile_pipeline_prev").click();

    // A filter on "Qualified" too ("today": "Conference Room" only).
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    await contains(".o_kanban_group:eq(1) .progress-bar.bg-warning").click();
    expect(".o_kanban_group:eq(1) .o_kanban_record").toHaveCount(1);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "1", null]);
    expect(cardNames()).toEqual(["Office Design"]);

    // Offline, the only filtered lead of "New" moves to the filtered "Qualified": the
    // source counts 0 and shows an empty stage (its lead was loaded, so no offline
    // helper), and the target counts the lead it shows once.
    await setOffline(true);
    const calls = trackCalls();
    await contains(`${card("Office Design")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    expect(headerTexts()).toEqual(["New", "0", null]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 0");
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(0);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "2", null]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 2");
    expect(cardNames()).toEqual(["Office Design", "Conference Room"]);
    expect(queued("crm.lead").map(({ method, args }) => [method, args])).toEqual([
        ["web_save", [[1], { stage_id: QUALIFIED }]],
    ]);
    expect(calls).toEqual(["crm.lead/web_save"]);

    // After the replay and the reload, the server's counts: "Office Design" is planned,
    // so "Qualified" filtered on "today" counts only "Conference Room".
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(headerTexts()).toEqual(["Qualified", "1", null]);
    expect(cardNames()).toEqual(["Conference Room"]);
    expect(
        MockServer.env["crm.lead"].search_read([["stage_id", "=", QUALIFIED]], ["name"])
    ).toEqual([
        { id: 1, name: "Office Design" },
        { id: 2, name: "Quote for Chairs" },
        { id: 4, name: "Conference Room" },
        { id: 5, name: "Lamps" },
        { id: 6, name: "Storage Racks" },
    ]);
});

test.tags("mobile");
test("mobile pipeline header counts a lead moved online in its saved stage while progress bars filter", async () => {
    onRpc("crm.lead", "get_rainbowman_message", () => false);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    // Two planned leads in "New", one in "Qualified".
    MockServer.env["crm.lead"].write([2, 5], { activity_state: "planned" });

    // "Planned" filters selected on both stages on a wide screen stay active on the phone.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    await contains(".o_kanban_group:eq(0) .progress-bar.bg-success").click();
    await contains(".o_kanban_group:eq(1) .progress-bar.bg-success").click();
    expect(".o_kanban_group:eq(0) .o_kanban_record").toHaveCount(2);
    expect(".o_kanban_group:eq(1) .o_kanban_record").toHaveCount(1);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "2", null]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "1", null]);
    await contains(".o_crm_mobile_pipeline_prev").click();

    // Online, a planned lead moves to "Qualified": its save refreshes both bar counts,
    // and the root (with its server-value snapshot) is not reloaded.
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_stage`).select(
        String(QUALIFIED)
    );
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "1", null]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "2", null]);
    expect(cardNames()).toEqual(["Quote for Chairs", "Lamps"]);

    // Offline, a revenue edit of the same lead in its form, loaded online beside the
    // still mounted pipeline (another Record of the lead, and no root reload): one
    // queued save without stage, and both counts stay those of the server.
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 2,
        arch: leadFormArch,
        config: { actionId: ACTION_ID },
    });
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Quote for Chairs");
    await getService("mail.store").isReadyPromise;
    await setOffline(true);
    const calls = trackCalls();
    await contains(".o_form_view .o_field_widget[name=expected_revenue] input").edit("210");
    await contains(".o_form_view .o_form_button_save").click();
    const [edit] = queued("crm.lead");
    expect([edit.method, edit.args[0], edit.args[1].expected_revenue]).toEqual([
        "web_save",
        [2],
        210,
    ]);
    expect("stage_id" in edit.args[1]).toBe(false);
    expect(textOf(`${card("Quote for Chairs")} .o_crm_mobile_pending_sync`)).toBe("Pending sync");
    expect(headerTexts()).toEqual(["Qualified", "2", null]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 2");
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(headerTexts()).toEqual(["New", "1", null]);
    expect(cardNames()).toEqual(["Office Design"]);

    // Offline, the same lead moves on to "Won": "New" is unchanged, "Qualified" counts
    // one lead less and "Won" one more.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_stage`).select(String(WON));
    expect(headerTexts()).toEqual(["Qualified", "1", null]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 1");
    expect(cardNames()).toEqual(["Lamps"]);
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(headerTexts()).toEqual(["New", "1", null]);
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Won", "2", "$ 1,110"]);
    expect(cardNames()).toEqual(["Quote for Chairs"]);
    expect(queued("crm.lead").map(({ method, args }) => [method, args[0]])).toEqual([
        ["web_save", [2]],
        ["web_save", [2]],
    ]);
    expect(queued("crm.lead")[1].args[1]).toEqual({ stage_id: WON });
    expect(calls).toEqual(["crm.lead/web_save", "crm.lead/web_save"]);

    // After the replay and the reload, the server's counts are the ones shown offline.
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(headerTexts()).toEqual(["Won", "2", "$ 1,110"]);
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(headerTexts()).toEqual(["Qualified", "1", null]);
    expect(cardNames()).toEqual(["Lamps"]);
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(headerTexts()).toEqual(["New", "1", null]);
    expect(cardNames()).toEqual(["Office Design"]);
    expect(
        MockServer.env["crm.lead"].search_read([["id", "=", 2]], ["stage_id", "expected_revenue"])
    ).toEqual([{ id: 2, stage_id: [WON, "Won"], expected_revenue: 210 }]);
});

test.tags("mobile");
test("mobile pipeline header counts leads whose stage is not loaded in their group while a progress bar filters", async () => {
    let holdRootLoads = null;
    onRpc("crm.lead", "web_read_group", () => holdRootLoads?.promise);
    // The Leads arch on a wide screen loads no stage (its desktop variant).
    await resize({ width: 1366, height: 768 });
    await mountWithCleanup(WebClient);
    await openAction(LEADS_ACTION_ID);
    await contains(".o_kanban_group:first .progress-bar.bg-success").click();
    expect(".o_kanban_group:first .o_kanban_record").toHaveCount(1);

    // On the phone, while the mobile variant loads, the displayed root is the desktop
    // variant's: its filtered lead counts once, in the group holding it.
    holdRootLoads = Promise.withResolvers();
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(headerTexts()).toEqual(["New", "1", null]);
    expect(cardNames()).toEqual(["Office Design"]);
    holdRootLoads.resolve();
    holdRootLoads = null;
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "1", null]);
    expect(cardNames()).toEqual(["Office Design"]);
});

test.tags("mobile");
test("mobile pipeline header keeps the progress-bar count through an offline reload", async () => {
    expect.errors(1);
    onRpc("crm.lead", "get_rainbowman_message", () => false);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    // Two planned leads in "New".
    MockServer.env["crm.lead"].write([2], { activity_state: "planned" });

    // A progress-bar filter selected on a wide screen stays active on the phone.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    await contains(".o_kanban_group:first .progress-bar.bg-success").click();
    expect(".o_kanban_group:first .o_kanban_record").toHaveCount(2);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "2", null]);

    // Offline, a move out, then its discard in the offline systray: the root reloads
    // from the cache, where the progress-bar counts cannot be read, and the filter
    // stays. The header keeps the filtered count and still omits the revenue.
    // Offline only once the messaging store's first fetch is answered: the network
    // would otherwise fail it.
    await getService("mail.store").isReadyPromise;
    await setOffline(true);
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_stage`).select(
        String(QUALIFIED)
    );
    expect(headerTexts()).toEqual(["New", "1", null]);
    await contains("div.o_nav_entry.o_offline_systray").click();
    await contains(".o-dropdown--menu button[title='Discard offline changes']").click();
    await contains(".modal-dialog .modal-footer button.btn-primary").click();
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);
    expect(headerTexts()).toEqual(["New", "2", null]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 2");
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(0);

    // A move out after that reload is counted once, from that count.
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_stage`).select(
        String(QUALIFIED)
    );
    expect(headerTexts()).toEqual(["New", "1", null]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 1");
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 900"]);
    // The framework's offline root load served from the cache.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

test.tags("mobile");
test("mobile pipeline shows a lead created offline in an uncached stage above the offline helper", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    // Offline only once the messaging store's first fetch is answered: the network
    // would otherwise fail it.
    await getService("mail.store").isReadyPromise;
    await setOffline(true);
    const calls = trackCalls();

    // "Won" is folded: its leads were never loaded, and the helper explains them.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Won", "1", "$ 900"]);
    expect(".o_crm_mobile_pipeline_body > .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    expect(".o_crm_mobile_lead_card").toHaveCount(0);

    // A lead created there offline: the header counts it, its provisional card shows
    // at once, and the helper stays below it for the uncached lead.
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    expect(headerTexts()).toEqual(["Won", "2", "$ 950"]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 2, expected revenue: $ 950");
    expect(cardNames()).toEqual(["Offline Lead"]);
    expect(".o_crm_mobile_lead_card_provisional").toHaveCount(1);
    expect(textOf(`${card("Offline Lead")} .o_crm_mobile_pending_sync`)).toBe("Pending sync");
    const helper = ".o_crm_mobile_pipeline_body > .o_view_nocontent";
    expect(`${helper} .fa-chain-broken`).toHaveCount(1);
    expect(".o_crm_mobile_pipeline_body").toHaveText(/There is no data to display offline/);
    // In the body's flow, after the card and the skip link's end marker, so the skip
    // link passes the card and leaves the focus right before the helper: the helper
    // covers no part of the card.
    expect(helper).toHaveStyle({ position: "relative" });
    const follows = (a, b) =>
        Boolean(
            queryFirst(a).compareDocumentPosition(queryFirst(b)) & Node.DOCUMENT_POSITION_FOLLOWING
        );
    expect(follows(".o_crm_mobile_lead_card_provisional", CARDS_END)).toBe(true);
    expect(follows(CARDS_END, helper)).toBe(true);
    const cardRect = queryFirst(".o_crm_mobile_lead_card_provisional").getBoundingClientRect();
    expect(queryFirst(helper).getBoundingClientRect().top).toBeGreaterThan(cardRect.bottom - 1);
    const [create] = queued("crm.lead");
    expect([create.method, create.args[0], create.args[1].stage_id]).toEqual(["web_save", [], WON]);
    expect(queued("crm.lead")).toHaveLength(1);
    expect(calls).toEqual([]);
});

test.tags("mobile");
test("mobile pipeline header sums the offline creates and moves of a stage without server leads", async () => {
    expandStageGroups();
    const setOffline = mockOffline();
    // The won stage's only lead is filtered out: the server sums no lead there (`false`).
    await mountPipeline({ domain: [["name", "!=", "Signed Deal"]] });
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Won", "0", "$ 0"]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 0, expected revenue: $ 0");

    // Offline, a lead created there adds its revenue.
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    expect(cardNames()).toEqual(["Offline Lead"]);
    expect(headerTexts()).toEqual(["Won", "1", "$ 50"]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 1, expected revenue: $ 50");

    // A lead moved there leaves its source's revenue and joins the stage's once.
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
    await contains(`${card("Lamps")} .o_crm_mobile_lead_stage`).select(String(WON));
    expect(headerTexts()).toEqual(["Qualified", "2", "$ 650"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(cardNames()).toEqual(["Lamps", "Offline Lead"]);
    expect(headerTexts()).toEqual(["Won", "2", "$ 100"]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 2, expected revenue: $ 100");

    // After the replay and the reload, the server sums both.
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(headerTexts()).toEqual(["Won", "2", "$ 100"]);
    expect(MockServer.env["crm.lead"].search_read([["stage_id", "=", WON]], ["name"])).toEqual([
        { id: 5, name: "Lamps" },
        { id: 7, name: "Signed Deal" },
        { id: 8, name: "Offline Lead" },
    ]);
});

/** The empty-state line of the displayed stage. */
const EMPTY_STAGE = ".o_crm_mobile_pipeline_body .o_crm_mobile_pipeline_empty";

/** Computed text colour of the empty-state lines (`$gray-700`, #495057). */
const EMPTY_STATE_COLOR = "rgb(73, 80, 87)";

test.tags("mobile");
test("mobile pipeline dims the sample data of an empty pipeline and keeps it inert and silent", async () => {
    expandStageGroups();
    const setOffline = mockOffline();
    await mountPipeline({
        arch: pipelineArch.replace("<kanban ", '<kanban sample="1" '),
        domain: OFFLINE_LEAD_DOMAIN,
    });
    expect(".o_view_sample_data").toHaveCount(1);
    expect(ROOT_HELPER).toHaveCount(1);

    // Sample cards: dimmed, unreachable by pointer and keyboard, hidden from
    // assistive technology.
    const sampleCards = queryAll(".o_crm_mobile_lead_card");
    expect(sampleCards.length).toBeGreaterThan(0);
    for (const sampleCard of sampleCards) {
        expect(sampleCard).toHaveAttribute("inert");
        expect(sampleCard).toHaveAttribute("aria-hidden", "true");
        expect(sampleCard).toHaveStyle({ opacity: "0.06", pointerEvents: "none" });
    }
    const sampleOpen = queryFirst(".o_crm_mobile_lead_card .o_crm_mobile_lead_open");
    sampleOpen.focus();
    expect(sampleOpen).not.toBeFocused();
    // No skip link or end marker frames the inert sample cards.
    expect(SKIP_LINK).toHaveCount(0);
    expect(CARDS_END).toHaveCount(0);
    // The sample count and revenue: dimmed and never announced. The bare numbers
    // are hidden from assistive technology, and the status region that reads them
    // out, labelled, stays silent.
    expect(".o_crm_mobile_pipeline_summary").toHaveAttribute("aria-hidden", "true");
    expect(".o_crm_mobile_pipeline_summary").toHaveStyle({ opacity: "0.06" });
    expect(HEADER_STATUS).toHaveCount(1);
    expect(textOf(HEADER_STATUS)).toBe("");
    // Sample data is no empty stage.
    expect(EMPTY_STAGE).toHaveCount(0);

    // The stage name and controls stay usable, by button and by swipe.
    expect(".o_crm_mobile_pipeline_stage_name").toHaveStyle({ opacity: "1" });
    expect(".o_crm_mobile_pipeline_body").not.toHaveAttribute("inert");
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Qualified");
    expect(textOf(HEADER_STATUS)).toBe("");
    await swipe(240);
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("New");

    // Offline create: sample mode ends, and cards, header and status are real again.
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    expect(".o_view_sample_data").toHaveCount(0);
    expect(cardNames()).toEqual(["Offline Lead"]);
    expect(".o_crm_mobile_lead_card").not.toHaveAttribute("inert");
    expect(".o_crm_mobile_lead_card").not.toHaveAttribute("aria-hidden");
    expect(".o_crm_mobile_lead_card").toHaveStyle({ opacity: "1" });
    expect(SKIP_LINK).toHaveCount(1);
    expect(CARDS_END).toHaveCount(1);
    // The real count and revenue: at full opacity, and announced by the status
    // region below (the bare numbers stay hidden from assistive technology).
    expect(".o_crm_mobile_pipeline_summary").toHaveAttribute("aria-hidden", "true");
    expect(".o_crm_mobile_pipeline_summary").toHaveStyle({ opacity: "1" });
    // No real lead is loaded: the revenue is in the company currency.
    expect(textOf(HEADER_STATUS)).toBe("Leads: 1, expected revenue: $ 50");
    expect(EMPTY_STAGE).toHaveCount(0);
    // The other stages lost their sample leads: they are empty, and say so.
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "0", "$ 0"]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 0, expected revenue: $ 0");
    expect(EMPTY_STAGE).toHaveText("No leads in this stage");
});

test.tags("mobile");
test("mobile pipeline keeps the sample data of an empty ungrouped list dimmed and inert, without skip link", async () => {
    await mountPipeline({
        arch: leadsArch.replace("<kanban ", '<kanban sample="1" '),
        groupBy: [],
        domain: OFFLINE_LEAD_DOMAIN,
    });
    expect(".o_view_sample_data").toHaveCount(1);
    expect(ROOT_HELPER).toHaveCount(1);
    expect(".o_crm_mobile_pipeline_ungrouped").toHaveCount(1);
    const sampleCards = queryAll(".o_crm_mobile_lead_card");
    expect(sampleCards.length).toBeGreaterThan(0);
    for (const sampleCard of sampleCards) {
        expect(sampleCard).toHaveAttribute("inert");
        expect(sampleCard).toHaveAttribute("aria-hidden", "true");
        expect(sampleCard).toHaveStyle({ opacity: "0.06", pointerEvents: "none" });
    }
    // Nothing of the list takes the focus: its card controls are inert, and it has
    // no skip link or end marker.
    expect(SKIP_LINK).toHaveCount(0);
    expect(CARDS_END).toHaveCount(0);
    expect(
        getFocusableElements().filter(
            (el) => el.closest(".o_crm_mobile_pipeline_body") && !el.closest("[inert]")
        )
    ).toEqual([]);
});

test.tags("mobile");
test("mobile pipeline header controls stay tappable above the sample data helper in a short viewport", async () => {
    expandStageGroups();
    // A short screen, as a phone in landscape: the root helper, centred in the
    // short content area, reaches over the sticky stage header. The width stays
    // within the test browser's own 375 px window, where hit tests apply.
    await resize({ width: 375, height: 375 });
    await mountPipeline({
        arch: pipelineArch.replace("<kanban ", '<kanban sample="1" '),
        domain: OFFLINE_LEAD_DOMAIN,
    });
    expect(".o_view_sample_data").toHaveCount(1);
    expect(ROOT_HELPER).toHaveCount(1);
    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    const zIndex = (selector) => Number(getComputedStyle(queryFirst(selector)).zIndex);
    expect(zIndex(".o_crm_mobile_pipeline_header")).toBeGreaterThan(zIndex(ROOT_HELPER));

    /**
     * The button a tap at the centre of the control `selector` lands on, as the
     * browser hit-tests it.
     *
     * @param {string} selector
     */
    const tapTarget = (selector) => {
        const { x, y, width, height } = queryFirst(selector).getBoundingClientRect();
        return document.elementFromPoint(x + width / 2, y + height / 2)?.closest("button") || null;
    };
    const next = ".o_crm_mobile_pipeline_next";
    const previous = ".o_crm_mobile_pipeline_prev";
    const create = ".o_crm_mobile_pipeline_new";
    // The helper's text box covers the centre of the header's controls.
    const helpTop = queryFirst(`${ROOT_HELPER} .o_nocontent_help`).getBoundingClientRect().top;
    const nextRect = queryFirst(next).getBoundingClientRect();
    expect(helpTop).toBeLessThan(nextRect.top + nextRect.height / 2);
    expect(tapTarget(next)).toBe(queryFirst(next));
    expect(tapTarget(create)).toBe(queryFirst(create));
    // A tap where the browser lands changes the stage, and so does one on Previous.
    await contains(tapTarget(next)).click();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Qualified");
    expect(tapTarget(previous)).toBe(queryFirst(previous));
    await contains(tapTarget(previous)).click();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("New");
    expect(".o_view_sample_data").toHaveCount(1);
});

test.tags("mobile");
test("mobile pipeline says when a stage has no leads on both arches online and offline", async () => {
    expandStageGroups();
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    for (const viewId of [false, LEADS_VIEW_ID]) {
        // The won stage's only lead is filtered out: that stage has no lead.
        await getService("action").doAction(
            {
                type: "ir.actions.act_window",
                res_model: "crm.lead",
                views: [
                    [viewId, "kanban"],
                    [false, "form"],
                ],
                domain: [["name", "!=", "Signed Deal"]],
                context: { ...PIPELINE_CONTEXT, group_by: ["stage_id"] },
                cache: true,
            },
            { clearBreadcrumbs: true }
        );
        // A stage with cards has no empty-state line.
        expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
        expect(EMPTY_STAGE).toHaveCount(0);
        await contains(".o_crm_mobile_pipeline_next").click();
        await contains(".o_crm_mobile_pipeline_next").click();
        expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Won");
        expect(textOf(".o_crm_mobile_pipeline_count")).toBe("0");
        expect(".o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(0);
        expect(ROOT_HELPER).toHaveCount(0);
        expect(EMPTY_STAGE).toHaveCount(1);
        expect(EMPTY_STAGE).toHaveText("No leads in this stage");
        // No second live region: the header status already reads "Leads: 0".
        expect(EMPTY_STAGE).not.toHaveAttribute("role");
        expect(EMPTY_STAGE).not.toHaveAttribute("aria-live");
        expect(EMPTY_STAGE).toHaveStyle({ color: EMPTY_STATE_COLOR });
    }

    // Offline, a stage known to be empty still says so, until a lead is created there.
    await setOffline(true);
    expect(EMPTY_STAGE).toHaveText("No leads in this stage");
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    expect(cardNames()).toEqual(["Offline Lead"]);
    expect(EMPTY_STAGE).toHaveCount(0);
});

test.tags("mobile");
test("mobile pipeline shows the offline helper and no empty-stage line for an uncached stage", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    // Offline, the folded "Won" stage was never loaded: the offline helper explains it.
    await setOffline(true);
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Won", "1", "$ 900"]);
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    expect(EMPTY_STAGE).toHaveCount(0);
});

test.tags("mobile");
test("mobile pipeline shows no empty-stage line while a folded stage loads its leads", async () => {
    let holdGroupLoad = null;
    onRpc("crm.lead", "web_search_read", () => holdGroupLoad?.promise);
    await mountPipeline();
    // While the folded "Won" stage loads its lead, the stage counts it: no line.
    holdGroupLoad = Promise.withResolvers();
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Won", "1", "$ 900"]);
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(EMPTY_STAGE).toHaveCount(0);
    holdGroupLoad.resolve();
    holdGroupLoad = null;
    await animationFrame();
    expect(cardNames()).toEqual(["Signed Deal"]);
    expect(EMPTY_STAGE).toHaveCount(0);
});

test.tags("mobile");
test("mobile pipeline shows the empty-data helper and no empty-stage line for a search without leads", async () => {
    expandStageGroups();
    await mountPipeline({ domain: OFFLINE_LEAD_DOMAIN });
    expect(".o_view_sample_data").toHaveCount(0);
    // No lead is loaded: the revenue is in the company currency.
    expect(headerTexts()).toEqual(["New", "0", "$ 0"]);
    expect(ROOT_HELPER).toHaveCount(1);
    expect(EMPTY_STAGE).toHaveCount(0);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "0", "$ 0"]);
    expect(ROOT_HELPER).toHaveCount(1);
    expect(EMPTY_STAGE).toHaveCount(0);
});

test.tags("mobile");
test("mobile pipeline header revenue keeps the company currency when a search empties the pipeline", async () => {
    expandStageGroups();
    let controller = null;
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    /**
     * Searches a name no lead matches, then reads the header of every stage.
     *
     * @returns {Promise<{header: (string|null)[], status: string|null}[]>}
     */
    async function searchNoMatch() {
        controller.env.searchModel.splitAndAddDomain(`[("name", "ilike", "zzzznomatch")]`);
        await animationFrame();
        await animationFrame();
        expect(".o_crm_mobile_lead_card").toHaveCount(0);
        const stages = [];
        for (let index = 0; index < 3; index++) {
            if (index) {
                await contains(".o_crm_mobile_pipeline_next").click();
            }
            stages.push({ header: headerTexts(), status: textOf(HEADER_STATUS) });
        }
        return stages;
    }
    await mountWithCleanup(WebClient);

    // The pipeline arch (progress-bar sum field): every emptied stage sums 0 in the
    // company currency, as an empty stage shows it beside loaded leads.
    await openAction(ACTION_ID);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(await searchNoMatch()).toEqual(
        ["New", "Qualified", "Won"].map((stage) => ({
            header: [stage, "0", "$ 0"],
            status: "Leads: 0, expected revenue: $ 0",
        }))
    );

    // The Leads arch (no sum field) keeps the currency the loaded leads share only:
    // with no lead loaded, its revenue has none.
    await openAction(LEADS_ACTION_ID);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(await searchNoMatch()).toEqual(
        ["New", "Qualified", "Won"].map((stage) => ({
            header: [stage, "0", "0"],
            status: "Leads: 0, expected revenue: 0",
        }))
    );
});

test.tags("mobile");
test("mobile pipeline focuses the uncached-lead helper, described by its text, and the lead after Back", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    const open = `${card("Quote for Chairs")} .o_crm_mobile_lead_open`;

    // The card's button leaves with the cards: "Back" takes the focus.
    await contains(open).click();
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(".o_crm_mobile_pipeline_helper_back").toBeFocused();
    const describedBy = queryFirst(".o_crm_mobile_pipeline_helper_back").getAttribute(
        "aria-describedby"
    );
    expect(describedBy).toMatch(/^o_crm_mobile_pipeline_lead_helper_\d+$/);
    expect(`[id="${describedBy}"]`).toHaveCount(1);
    expect(`[id="${describedBy}"]`).toHaveText(
        /^There is no data to display offline for the given filters/
    );
    expect(`[id="${describedBy}"] .o_crm_mobile_pipeline_helper_back`).toHaveCount(0);
    // The wrapper generates no box: the helper keeps its place in the body's flow.
    expect(`[id="${describedBy}"]`).toHaveStyle({ display: "contents" });
    expect(`[id="${describedBy}"] > .o_view_nocontent`).toHaveStyle({ position: "relative" });

    // "Back" gives the focus back to the lead's card.
    await contains(".o_crm_mobile_pipeline_helper_back").click();
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(open).toBeFocused();

    // The stage navigation leaves the helper without moving the focus.
    await contains(open).click();
    expect(".o_crm_mobile_pipeline_helper_back").toBeFocused();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_helper_back").toHaveCount(0);
    expect(".o_crm_mobile_pipeline_next").toBeFocused();
});

test.tags("mobile");
test("mobile pipeline focuses the uncached-lead helper of an ungrouped list, and the lead after Back", async () => {
    const setOffline = mockOffline();
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    await setOffline(true);
    const open = `${card("Lamps")} .o_crm_mobile_lead_open`;

    await contains(open).click();
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(".o_crm_mobile_pipeline_helper_back").toBeFocused();
    const describedBy = queryFirst(".o_crm_mobile_pipeline_helper_back").getAttribute(
        "aria-describedby"
    );
    expect(`[id="${describedBy}"]`).toHaveText(
        /^There is no data to display offline for the given filters/
    );

    await contains(".o_crm_mobile_pipeline_helper_back").click();
    expect(cardNames()).toHaveLength(7);
    expect(open).toBeFocused();
});

/** Activity sub-fields the mobile variant loads with every lead. */
const ACTIVITY_SUBFIELDS = ["summary", "activity_type_id", "date_deadline", "user_id", "state"];

/**
 * Opens the activity sheet of a lead card.
 *
 * @param {string} name
 */
async function openActivities(name) {
    await contains(`${card(name)} .o_crm_mobile_lead_activities_button`).click();
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
}

/** Titles of the activity rows of the open sheet (synced rows first). */
function activityTitles() {
    return queryAllTexts(".o_crm_mobile_activity_row .o_crm_mobile_activity_title");
}

/**
 * Closes the open bottom sheet through its backdrop.
 */
async function closeSheet() {
    await contains(".o_bottom_sheet_backdrop").click();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
}

test.tags("mobile");
test("mobile pipeline loads activity rows through the root load", async () => {
    const setOffline = mockOffline();
    const specs = rootSpecs();
    const calls = trackCalls();
    await mountPipeline();

    expect(specs.map(({ method }) => method)).toEqual(["web_read_group"]);
    const activitySpec = specs[0].specification.activity_ids;
    expect(Object.keys(activitySpec.fields)).toEqual(ACTIVITY_SUBFIELDS);
    expect(specs[0].aggregates).toInclude("expected_revenue:sum");

    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);
    await closeSheet();

    await setOffline(true);
    await contains(".o_crm_mobile_pipeline_next").click();
    await openActivities("Conference Room");
    expect(activityTitles()).toEqual(["Send the quote"]);
    await closeSheet();
    await contains(".o_crm_mobile_pipeline_prev").click();
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);

    expect(calls.filter((call) => call.startsWith("mail.activity/"))).toEqual([]);
    expect(specs).toHaveLength(1);
});

test.tags("mobile");
test("mobile pipeline activity rows survive a stage switch and an offline create", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    const calls = trackCalls();

    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();
    await quickCreateLead({ name: "Offline Lead", revenue: 10 });
    expect(cardNames()).toEqual([
        "Office Design",
        "Quote for Chairs",
        "Desk Upgrade",
        "Offline Lead",
    ]);

    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);
    await contains(
        ".o_crm_mobile_activity_row[data-activity-id='2'] .o_crm_mobile_activity_done"
    ).click();
    expect(
        ".o_crm_mobile_activity_row[data-activity-id='2'] .o_crm_mobile_activity_done"
    ).toHaveText("Done · Pending sync");
    expect(
        ".o_crm_mobile_activity_row[data-activity-id='2'] .o_crm_mobile_activity_done"
    ).toHaveAttribute("disabled");
    expect(queued("mail.activity").map(({ method, args }) => ({ method, args }))).toEqual([
        { method: "action_done", args: [[2]] },
    ]);

    // Still listed after switching stages again.
    await closeSheet();
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);
    expect(calls).toEqual([]);
});

test.tags("mobile");
test("mobile pipeline cold reopen serves activity rows from the disk cache", async () => {
    expect.errors(3);
    let rpcCache = null;
    const { setCache } = rpc;
    patchWithCleanup(rpc, {
        setCache(cache) {
            rpcCache = cache;
            return setCache.call(this, cache);
        },
    });
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    await animationFrame(); // let the disk cache be written

    // Offline, the pipeline is destroyed and opened again with a cold RAM cache.
    await setOffline(true);
    const calls = trackCalls();
    rpcCache.ramCache.invalidate();
    await openAction(ACTION_ID);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);
    expect(calls.filter((call) => call.startsWith("mail.activity/"))).toEqual([]);
    // Opening the action offline: the framework's cached loads of the action, its
    // views and its root raise the lost connection; CRM code adds none.
    expect.verifyErrors([
        "/web/action/load",
        "/web/dataset/call_kw/crm.lead/get_views",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile pipeline follows viewport changes", async () => {
    const specs = rootSpecs();
    const calls = trackCalls();
    const rootLoads = () => specs.filter(({ method }) => method === "web_read_group");
    const warmUps = () => calls.filter((call) => call === "mail.activity.type/web_search_read");

    // Mounted at desktop size: the arch's own specification, no activity type request.
    await resize({ width: 1366, height: 768 });
    await mountWithCleanup(WebClient);
    await openAction(LEADS_ACTION_ID);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(rootLoads()).toHaveLength(1);
    const [desktopLoad] = rootLoads();
    expect(desktopLoad.specification.activity_ids).toEqual({ fields: {} });
    expect(desktopLoad.specification).not.toInclude("partner_id");
    expect(desktopLoad.aggregates).toEqual([]);
    expect(warmUps()).toEqual([]);

    // Resized to mobile online: one root reload with the mobile variant, types warmed.
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(rootLoads()).toHaveLength(2);
    const mobileLoad = rootLoads()[1];
    expect(Object.keys(mobileLoad.specification.activity_ids.fields)).toEqual(ACTIVITY_SUBFIELDS);
    expect(mobileLoad.specification).toInclude("partner_id");
    expect(mobileLoad.aggregates).toInclude("expected_revenue:sum");
    expect(warmUps()).toHaveLength(1);
    const cachedTypes = await getService(OfflinePlugin).searchMany2XRecords(
        "mail.activity.type",
        ""
    );
    expect(cachedTypes.map(({ id }) => id).sort((a, b) => a - b)).toEqual([1, 2, 28]);

    // Resized back: the next root request equals the first desktop one.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(rootLoads()).toHaveLength(3);
    expect(rootLoads()[2].specification).toEqual(desktopLoad.specification);
    expect(rootLoads()[2].aggregates).toEqual(desktopLoad.aggregates);
    expect(warmUps()).toHaveLength(1);

    // Mounted at mobile size, then resized both ways: `isSmall` is read live.
    await resize({ width: 375, height: 667 });
    await openAction(ACTION_ID);
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(".o_kanban_group:first .o_kanban_record").toHaveCount(3);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(".o_kanban_group").toHaveCount(0);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
});

test.tags("mobile");
test("mobile pipeline closes an open quick create when the screen widens", async () => {
    const DESKTOP = { width: 1366, height: 768 };
    const MOBILE = { width: 375, height: 667 };
    // The pipeline renderer stays mounted across the resizes, so the sheet can only
    // leave through the renderer closing it, not through its quick-create hook
    // unmounting with it.
    let createdRenderers = 0;
    let destroyedRenderers = 0;
    patchWithCleanup(CrmMobilePipeline.prototype, {
        setup() {
            super.setup(...arguments);
            createdRenderers++;
            onWillDestroy(() => destroyedRenderers++);
        },
    });
    const saves = [];
    onRpc("crm.lead", "web_save", ({ args, kwargs }) => {
        // Copied: the mock server completes the values it creates in place.
        saves.push({ ids: [...args[0]], vals: { ...args[1] }, kwargs: { ...kwargs } });
    });
    const calls = trackCalls();
    const leadWrites = () =>
        calls.filter((call) =>
            ["crm.lead/web_save", "crm.lead/onchange", "crm.lead/create"].includes(call)
        );
    const sheet = "form.o_crm_mobile_quick_create";
    await mountPipeline();
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);

    // A quick create being filled in, on another stage than the displayed one.
    await contains(".o_crm_mobile_pipeline_new").click();
    expect(".o_bottom_sheet").toHaveCount(1);
    expect(`.o_bottom_sheet ${sheet}`).toHaveCount(1);
    expect(".o_bottom_sheet .o_bottom_sheet_backdrop").toHaveCount(1);
    expect(document.body).toHaveClass("bottom-sheet-open");
    await contains(`${sheet} input[name=name]`).edit("Unsaved Lead", { confirm: false });
    await contains(`${sheet} input[name=expected_revenue]`).edit("90", { confirm: false });
    await contains(`${sheet} select[name=stage_id]`).select(String(QUALIFIED));

    // Widened: the sheet leaves with the mobile pipeline (removed at once, without a
    // slide-out), the standard kanban renders, and nothing is saved or queued.
    await resize(DESKTOP);
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(sheet).toHaveCount(0);
    expect(".o_bottom_sheet_backdrop").toHaveCount(0);
    expect(document.body).not.toHaveClass("bottom-sheet-open");
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(".o_kanban_group:first .o_kanban_record").toHaveCount(3);
    expect(".o_kanban_quick_create").toHaveCount(0);
    expect([createdRenderers, destroyedRenderers]).toEqual([1, 0]);
    expect(leadWrites()).toEqual([]);
    expect(queued("crm.lead")).toEqual([]);

    // Small again: the pipeline is back on its stage, and the sheet does not reopen.
    await resize(MOBILE);
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(".o_kanban_group").toHaveCount(0);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(document.body).not.toHaveClass("bottom-sheet-open");
    expect([createdRenderers, destroyedRenderers]).toEqual([1, 0]);

    // "New" opens a fresh sheet on the displayed stage.
    await contains(".o_crm_mobile_pipeline_new").click();
    expect(`.o_bottom_sheet ${sheet}`).toHaveCount(1);
    expect(`${sheet} input[name=name]`).toHaveValue("");
    expect(`${sheet} input[name=expected_revenue]`).not.toHaveValue();
    expect(`${sheet} select[name=stage_id]`).toHaveValue(String(NEW));
    expect(leadWrites()).toEqual([]);

    // Saved online: the sheet closes after exactly one create.
    await contains(`${sheet} input[name=name]`).edit("Online Lead", { confirm: false });
    await contains(`${sheet} input[name=expected_revenue]`).edit("70", { confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(document.body).not.toHaveClass("bottom-sheet-open");
    expect(leadWrites()).toEqual(["crm.lead/web_save"]);
    expect(saves).toHaveLength(1);
    expect(saves[0].ids).toEqual([]);
    expect(saves[0].vals).toEqual(quickCreateValues("Online Lead", 70));
    expect(saves[0].kwargs.specification).toEqual({});
    expect(saves[0].kwargs.context.default_type).toBe("opportunity");
    expect(queued("crm.lead")).toEqual([]);
    expect(headerTexts()).toEqual(["New", "4", "$ 670"]);
    expect(card("Online Lead")).not.toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(MockServer.env["crm.lead"].search_count([["name", "=", "Unsaved Lead"]])).toBe(0);
});

test.tags("mobile");
test("control-panel New opens the mobile quick create on the displayed stage", async () => {
    const DESKTOP = { width: 1366, height: 768 };
    const MOBILE = { width: 375, height: 667 };
    let controller;
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    const saves = [];
    onRpc("crm.lead", "web_save", ({ args, kwargs }) => {
        // Copied: the mock server completes the values it creates in place.
        saves.push({ ids: [...args[0]], vals: { ...args[1] }, context: kwargs.context });
    });
    const calls = trackCalls();
    const panelNew = ".o_control_panel .o-kanban-button-new";
    const sheet = "form.o_crm_mobile_quick_create";
    await mountPipeline();
    // Quick-create requests (view, defaults, save) sent once the pipeline is mounted.
    const mountCalls = calls.length;
    const quickCreateCalls = () =>
        calls.slice(mountCalls).filter((call) => /\/(?:get_views|onchange|web_save)$/.test(call));
    expect(".o_crm_mobile_pipeline_new").toHaveCount(1);
    expect(panelNew).toHaveCount(1);

    // On the second stage, the control-panel "New" opens the sheet on that stage:
    // no framework quick create opens, and no request is sent.
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
    await contains(panelNew).click();
    expect(`.o_bottom_sheet ${sheet}`).toHaveCount(1);
    expect(`${sheet} select[name=stage_id]`).toHaveValue(String(QUALIFIED));
    expect(".o_kanban_quick_create").toHaveCount(0);
    expect(controller.quickCreateState.isOpen).toBe(false);
    expect(quickCreateCalls()).toEqual([]);
    await contains(".o_crm_mobile_quick_create_cancel").click();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    // The sheet gives the focus back to the control that opened it.
    expect(panelNew).toBeFocused();

    // Its Alt+C hotkey opens the sheet again, whose save creates the lead online as
    // the stage header's "New" does. The hotkey clicks the button in a timeout.
    await press(["alt", "c"]);
    await runAllTimers();
    await animationFrame();
    expect(`.o_bottom_sheet ${sheet}`).toHaveCount(1);
    expect(`${sheet} select[name=stage_id]`).toHaveValue(String(QUALIFIED));
    await contains(`${sheet} input[name=name]`).edit("Panel Lead", { confirm: false });
    await contains(`${sheet} input[name=expected_revenue]`).edit("30", { confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(saves).toHaveLength(1);
    expect(saves[0].ids).toEqual([]);
    expect(saves[0].vals).toEqual({
        ...quickCreateValues("Panel Lead", 30),
        stage_id: QUALIFIED,
    });
    expect(saves[0].context.default_type).toBe("opportunity");
    expect(queued("crm.lead")).toEqual([]);
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 730"]);
    expect(card("Panel Lead")).not.toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(quickCreateCalls()).toEqual(["crm.lead/web_save"]);
    expect(controller.quickCreateState.isOpen).toBe(false);
    expect(panelNew).toBeFocused();

    // Widened: the standard kanban, with neither a sheet nor a stale inline quick create.
    await resize(DESKTOP);
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(".o_kanban_quick_create").toHaveCount(0);
    expect(controller.quickCreateState.isOpen).toBe(false);

    // On a wide screen the control-panel "New" opens the framework's inline quick
    // create in the first column.
    await contains(panelNew).click();
    await animationFrame();
    expect(".o_kanban_group:first .o_kanban_quick_create").toHaveCount(1);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(controller.quickCreateState.isOpen).toBe(true);
    expect(quickCreateCalls()).toEqual(["crm.lead/web_save", "crm.lead/onchange"]);

    // Narrowed with that quick create open: its state closes, and no sheet opens.
    await resize(MOBILE);
    await animationFrame();
    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    expect(".o_kanban_quick_create").toHaveCount(0);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(controller.quickCreateState.isOpen).toBe(false);

    // The control-panel "New" still opens the sheet, on the displayed stage.
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 730"]);
    await contains(panelNew).click();
    expect(`.o_bottom_sheet ${sheet}`).toHaveCount(1);
    expect(`${sheet} select[name=stage_id]`).toHaveValue(String(QUALIFIED));
    expect(".o_kanban_quick_create").toHaveCount(0);
    expect(controller.quickCreateState.isOpen).toBe(false);
    expect(quickCreateCalls()).toEqual(["crm.lead/web_save", "crm.lead/onchange"]);
});

test.tags("mobile");
test("control-panel New keeps the framework form on an arch without quick create", async () => {
    await mountWithCleanup(WebClient);
    // The Leads arch has no `on_create="quick_create"`: grouped by stage on a phone,
    // its control-panel "New" opens the lead form, as on a wide screen.
    await openAction(LEADS_ACTION_ID);
    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    await contains(".o_control_panel .o-kanban-button-new").click();
    expect(".o_form_view").toHaveCount(1);
    expect(".o_field_widget[name=name] input").toHaveValue("");
    expect(".o_bottom_sheet").toHaveCount(0);
});

test.tags("mobile");
test("mobile pipeline follows viewport changes made during its first root load", async () => {
    const DESKTOP = { width: 1366, height: 768 };
    const MOBILE = { width: 375, height: 667 };
    const specs = rootSpecs();
    const rootLoads = () => specs.filter(({ method }) => method === "web_read_group");
    /** The next root request waits for `release`: `{reached, release}`, or `null`. */
    let hold = null;
    onRpc("crm.lead", "web_read_group", async () => {
        const held = hold;
        hold = null;
        if (held) {
            held.reached.resolve();
            await held.release.promise;
        }
    });

    /**
     * Opens an action at the current size, resizes to each of `sizes` while its
     * first root request is pending, then lets that request complete. A root load
     * served from the cache would not be pending: each visit opens an action
     * whose variant for the size it starts at was never loaded.
     *
     * @param {number} actionId
     * @param {{width: number, height: number}[]} sizes
     * @returns {Promise<Object[]>} the root requests of the visit, in order
     */
    const visitResizing = async (actionId, sizes) => {
        const loadCount = rootLoads().length;
        hold = { reached: Promise.withResolvers(), release: Promise.withResolvers() };
        const { reached, release } = hold;
        // Not awaited: the view may wait for its first root load to be mounted.
        const opened = openAction(actionId);
        await reached.promise;
        await animationFrame();
        // Still loading: no lead is displayed yet.
        expect(".o_kanban_record, .o_crm_mobile_lead_card").toHaveCount(0);
        for (const size of sizes) {
            await resize(size);
            await animationFrame();
        }
        release.resolve();
        await opened;
        await animationFrame();
        await animationFrame();
        return rootLoads().slice(loadCount);
    };
    await mountWithCleanup(WebClient);

    // Opened at mobile size, resized to desktop while loading: one corrective root
    // load, whose specification and aggregates are those `crm_kanban` loads.
    let loads = await visitResizing(ACTION_ID, [DESKTOP]);
    expect(loads).toHaveLength(2);
    expect(Object.keys(loads[0].specification.activity_ids.fields)).toEqual(ACTIVITY_SUBFIELDS);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(".o_kanban_group:first .o_kanban_record").toHaveCount(3);
    const correctedDesktopLoad = loads[1];
    const loadCount = rootLoads().length;
    await openAction(DESKTOP_ACTION_ID);
    loads = rootLoads().slice(loadCount);
    expect(loads).toHaveLength(1);
    expect(correctedDesktopLoad.specification).toEqual(loads[0].specification);
    expect(correctedDesktopLoad.aggregates).toEqual(loads[0].aggregates);

    // Crossed to mobile and back while loading: the first load still matches the
    // screen, so nothing is reloaded.
    loads = await visitResizing(LIMITED_ACTION_ID, [MOBILE, DESKTOP]);
    expect(loads).toHaveLength(1);
    expect(loads[0].specification).toEqual(correctedDesktopLoad.specification);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);

    // Opened at desktop size, resized to mobile while loading: one corrective root
    // load with the mobile variant, whose revenue aggregate the stage header shows.
    loads = await visitResizing(LEADS_ACTION_ID, [MOBILE]);
    expect(loads).toHaveLength(2);
    expect(loads[0].specification.activity_ids).toEqual({ fields: {} });
    expect(loads[0].specification).not.toInclude("partner_id");
    expect(loads[0].aggregates).toEqual([]);
    expect(Object.keys(loads[1].specification.activity_ids.fields)).toEqual(ACTIVITY_SUBFIELDS);
    expect(loads[1].specification).toInclude("partner_id");
    expect(loads[1].aggregates).toInclude("expected_revenue:sum");
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);

    // Crossed to desktop and back while loading: nothing is reloaded.
    loads = await visitResizing(LIMITED_ACTION_ID, [DESKTOP, MOBILE]);
    expect(loads).toHaveLength(1);
    expect(Object.keys(loads[0].specification.activity_ids.fields)).toEqual(ACTIVITY_SUBFIELDS);
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
});

test.tags("mobile");
test("mobile pipeline viewport reloads report a server error once", async () => {
    // One refused corrective root load per visit below.
    expect.errors(2);
    const DESKTOP = { width: 1366, height: 768 };
    const MOBILE = { width: 375, height: 667 };
    /**
     * `refuse`: the next root request to start fails on the server; `hold`: the next
     * root request waits for `release` (`{reached, release}`).
     */
    let refuse = false;
    let hold = null;
    onRpc("crm.lead", "web_read_group", async () => {
        const held = hold;
        const refused = refuse;
        hold = null;
        refuse = false;
        if (held) {
            held.reached.resolve();
            await held.release.promise;
        }
        if (refused) {
            expect.step("web_read_group refused");
            throw makeServerError({ message: "Pipeline reload refused" });
        }
    });
    await mountWithCleanup(WebClient);

    // Loaded, then resized to desktop: the reload of the never-loaded desktop
    // variant is refused, and the error is reported once, as the standard dialog.
    await openAction(ACTION_ID);
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    refuse = true;
    await resize(DESKTOP);
    await animationFrame();
    await expect.waitForSteps(["web_read_group refused"]);
    await waitFor(".o_error_dialog:contains(Pipeline reload refused)");
    await animationFrame();
    expect(".o_error_dialog").toHaveCount(1);
    expect.verifyErrors(["Pipeline reload refused"]);
    await contains(".o_error_dialog .modal-footer .btn-primary").click();
    expect(".o_error_dialog").toHaveCount(0);
    await resize(MOBILE);
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);

    // Three crossings while the first root load runs share one corrective reload:
    // refused, it is reported once, not once per crossing. Hoot counts one error
    // object once, so the dialog count shows a repeated report.
    hold = { reached: Promise.withResolvers(), release: Promise.withResolvers() };
    const { reached, release } = hold;
    const opened = openAction(LEADS_ACTION_ID);
    await reached.promise;
    await animationFrame();
    for (const size of [DESKTOP, MOBILE, DESKTOP]) {
        await resize(size);
        await animationFrame();
    }
    refuse = true;
    release.resolve();
    await opened;
    await expect.waitForSteps(["web_read_group refused"]);
    await waitFor(".o_error_dialog:contains(Pipeline reload refused)");
    await animationFrame();
    await animationFrame();
    expect(".o_error_dialog").toHaveCount(1);
    expect.verifyErrors(["Pipeline reload refused"]);
});

test.tags("mobile");
test("mobile pipeline falls back to the desktop variant offline after a wide-layout visit", async () => {
    expect.errors(1);
    const setOffline = mockOffline();
    // Visited online at desktop size only.
    await resize({ width: 1366, height: 768 });
    await mountWithCleanup(WebClient);
    await openAction(LEADS_ACTION_ID);
    expect(".o_kanban_group").toHaveCount(3);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);

    // Resize the mounted desktop pipeline to mobile offline: its root load tries the mobile
    // variant, then falls back to cached desktop data. Reusing the view preserves the framework's
    // screen-size-specific view description.
    await setOffline(true);
    const calls = trackCalls();
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(0);
    // The Leads arch has no revenue: the desktop variant loads none.
    expect(headerTexts()).toEqual(["New", "3", null]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(".o_crm_mobile_lead_revenue").toHaveCount(0);
    expect(queryAllTexts(".o_crm_mobile_lead_partner")).toEqual(["Bob Contact"]);
    // Nor its stage: the cards have no stage selector, and keep their activities.
    expect(".o_crm_mobile_lead_stage").toHaveCount(0);
    expect(".o_crm_mobile_lead_card .o_crm_mobile_lead_activities_button").toHaveCount(3);

    // The activity sheet lists the next activity, whose "Mark done" works.
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call"]);
    // The list and the notice announce their changes politely.
    expect(".o_crm_mobile_lead_activities").toHaveAttribute("aria-live", "polite");
    expect(".o_crm_mobile_activities_more").toHaveAttribute("role", "status");
    // One other activity: the count reads in the singular.
    expect(".o_crm_mobile_activities_more").toHaveText("1 more activity after sync");
    await contains(
        ".o_crm_mobile_activity_row[data-activity-id='1'] .o_crm_mobile_activity_done"
    ).click();
    expect(
        ".o_crm_mobile_activity_row[data-activity-id='1'] .o_crm_mobile_activity_done"
    ).toHaveText("Done · Pending sync");
    // Scheduling stays available, with the types the desktop visit cached.
    await contains(".o_crm_mobile_schedule_followup").click();
    await contains(".o_crm_mobile_activity_summary").edit("Visit", { confirm: false });
    await contains(".o_crm_mobile_activity_save").click();
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Visit");
    // Like a synced row, the queued one names its assignee: the session user by default.
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_assignee").toHaveText(
        "Mitchell Admin"
    );
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_pending_sync").toHaveText("Pending sync");
    // A lead without activities: no row and no "more" count.
    await closeSheet();
    await openActivities("Quote for Chairs");
    expect(".o_crm_mobile_activity_row").toHaveCount(0);
    expect(".o_crm_mobile_activities_more").toHaveCount(0);
    expect(".o_crm_mobile_activities_notice").toHaveCount(0);
    expect(".o_crm_mobile_schedule_followup").toBeEnabled();
    expect(queued("mail.activity").map(({ method }) => method)).toEqual(["action_done", "create"]);
    expect(calls.filter((call) => call.startsWith("mail.activity"))).toEqual([]);
    // Only the framework's cached root load (the desktop variant, served offline).
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

/**
 * Opens the Opportunities pipeline in the web client at desktop width and visits a
 * lead's form there (then goes back): only the wide-layout view descriptions and
 * the form's desktop load are cached, and the lead is marked visited.
 *
 * @param {string} name
 */
async function visitLeadAtDesktopWidth(name) {
    await resize({ width: 1366, height: 768 });
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(`.o_kanban_record:contains(${name})`).click();
    expect(".o_form_view").toHaveCount(1);
    expect(".o_crm_mobile_activities_button").toHaveCount(0);
    await contains(".o_back_button").click();
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
}

test.tags("mobile");
test("mobile pipeline opens offline the cached form of a lead visited only at desktop width", async () => {
    expect.errors(3);
    const viewOptions = [];
    onRpc("crm.lead", "get_views", ({ kwargs }) => {
        viewOptions.push(kwargs.options);
    });
    const setOffline = mockOffline();
    await visitLeadAtDesktopWidth("Office Design");
    expect(viewOptions.map((options) => "mobile" in options)).toEqual([false]);

    // Offline on a phone, the pipeline shows the desktop variant from the cache.
    await setOffline(true);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    const calls = trackCalls();

    // The lead opens in its cached form: the small-screen view descriptions were
    // never cached, so the wide-layout ones are read (from the cache, with no other
    // request), then the form's desktop load.
    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();
    await animationFrame();
    expect(".o_form_view").toHaveCount(1);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design");
    expect(calls).toEqual(["crm.lead/get_views", "crm.lead/web_read", "crm.lead/web_read"]);
    expect(viewOptions).toHaveLength(1);

    // Its phone "Activities" sheet has no activity data (named limit): it offers
    // scheduling only.
    await contains(".o_crm_mobile_activities_button").click();
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(".o_crm_mobile_activities_notice").toHaveText("Activities load after sync");
    expect(".o_crm_mobile_activity_row").toHaveCount(0);
    expect(".o_crm_mobile_schedule_followup").toBeEnabled();
    await closeSheet();

    // Back restores the pipeline, from the same caches.
    await contains(".o_back_button").click();
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(viewOptions).toHaveLength(1);
    // Only the framework's cached root loads, served offline: the pipeline after the
    // resize, the form, and the pipeline after Back.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile pipeline shows the replayed activities after an offline form visit of a lead seen at desktop width", async () => {
    expect.errors(3);
    let pipeline;
    let controller;
    patchWithCleanup(CrmMobilePipeline.prototype, {
        setup() {
            super.setup(...arguments);
            pipeline = this;
        },
    });
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    const setOffline = mockOffline();
    await visitLeadAtDesktopWidth("Office Design");

    // Offline on a phone, the lead's cached form opens, and Back restores the pipeline.
    await setOffline(true);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();
    await animationFrame();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_back_button").click();
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(pipeline.props.list).toBe(controller.model.root);

    // The desktop variant lists the next activity, which is marked done offline.
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call"]);
    expect(".o_crm_mobile_activities_more").toHaveText("1 more activity after sync");
    await contains(`${activityRow(1)} .o_crm_mobile_activity_done`).click();
    expect(`${activityRow(1)} .o_crm_mobile_activity_done`).toHaveText("Done · Pending sync");
    await closeSheet();
    expect(queued("mail.activity").map(({ method, args }) => [method, args])).toEqual([
        ["action_done", [[1]]],
    ]);

    // Reconnected, the replay reloads the root with the mobile variant: the pipeline
    // renders that root, and its sheet lists the server's rows.
    await reconnect(setOffline);
    expect(queued("mail.activity")).toEqual([]);
    expect(MockServer.env["mail.activity"].search_read([["id", "=", 1]], ["id"])).toEqual([]);
    expect(pipeline.props.list).toBe(controller.model.root);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Send brochure"]);
    expect(activityRow(1)).toHaveCount(0);
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).toHaveText("Mark done");
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).toBeEnabled();
    expect(".o_crm_mobile_activities_more").toHaveCount(0);
    // Only the framework's cached root loads, served offline: the pipeline after the
    // resize, the form, and the pipeline after Back.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile pipeline reconciles after replay", async () => {
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (args[1]?.name === "Rejected Lead") {
            throw makeServerError({ message: "Invalid lead" });
        }
    });
    const setOffline = mockOffline();
    await mountPipeline({ selectRecord: (resId) => expect.step(`open ${resId}`) });
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 10 });
    await quickCreateLead({ name: "Rejected Lead", revenue: 20 });
    expect(".o_crm_mobile_lead_card_provisional").toHaveCount(2);
    expect(`${card("Offline Lead")} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");
    expect(`${card("Offline Lead")} .o_crm_mobile_lead_open`).toHaveAttribute("disabled");

    await reconnect(setOffline);
    // The replayed create is now a server card, which opens.
    expect(card("Offline Lead")).not.toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(`${card("Offline Lead")} .o_crm_mobile_pending_sync`).toHaveCount(0);
    expect(`${card("Offline Lead")} .o_crm_mobile_lead_activities_button`).not.toHaveAttribute(
        "disabled"
    );
    await contains(`${card("Offline Lead")} .o_crm_mobile_lead_open`).click();
    expect.verifySteps(["open 8"]);
    // The rejected create is parked: its card stays, with "Sync failed".
    expect(card("Rejected Lead")).toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(`${card("Rejected Lead")} .o_crm_mobile_pending_sync`).toHaveText("Sync failed");
    const [parked] = queued("crm.lead");
    expect(parked.args[1].name).toBe("Rejected Lead");
    expect(parked.extras.error).toInclude("Invalid lead");
    expect(cardNames()).toEqual([
        "Office Design",
        "Quote for Chairs",
        "Desk Upgrade",
        "Offline Lead",
        "Rejected Lead",
    ]);
});

test.tags("mobile");
test("mobile pipeline does not reload at a sync with nothing to replay after a discard", async () => {
    expect.errors(2);
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (args[1]?.name === "Rejected Lead") {
            throw makeServerError({ message: "Invalid lead" });
        }
    });
    const setOffline = mockOffline();
    await mountPipeline();
    const plugin = getService(OfflinePlugin);
    const calls = trackCalls();

    // A lead write discarded offline: the discard reloads the root (from the cache).
    await setOffline(true);
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);
    const [move] = queued("crm.lead");
    plugin.removeScheduledORM(move.key);
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(calls).toEqual([
        "crm.lead/web_save",
        "crm.lead/read_progress_bar",
        "crm.lead/web_read_group",
    ]);

    // Reconnecting ends a sync with nothing replayed: the root is not reloaded.
    calls.splice(0);
    await reconnect(setOffline);
    expect(calls).toEqual([]);

    // The same for a discarded activity, which the pipeline does not reload for.
    await setOffline(true);
    await openActivities("Office Design");
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    const [activity] = queued("mail.activity");
    expect(activity.method).toBe("create");
    await closeSheet();
    plugin.removeScheduledORM(activity.key);
    await animationFrame();
    expect(queued("mail.activity")).toEqual([]);
    await reconnect(setOffline);
    expect(calls).toEqual([]);

    // A replay still reconciles, once; the rejected create stays parked.
    await setOffline(true);
    await quickCreateLead({ name: "Rejected Lead", revenue: 20 });
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    calls.splice(0);
    await reconnect(setOffline);
    expect(calls.filter((call) => call === "crm.lead/web_read_group")).toEqual([
        "crm.lead/web_read_group",
    ]);
    expect(MockServer.env["crm.lead"].search_read([["id", "=", 3]], ["stage_id"])).toEqual([
        { id: 3, stage_id: [QUALIFIED, "Qualified"] },
    ]);
    const [parked] = queued("crm.lead");
    expect(parked.extras.error).toInclude("Invalid lead");

    // A parked entry is never replayed: once a discard leaves only it, the next
    // sync replays nothing and does not reload either.
    await setOffline(true);
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_stage`).select(
        String(QUALIFIED)
    );
    const write = queued("crm.lead").find(({ key }) => key !== parked.key);
    plugin.removeScheduledORM(write.key);
    await animationFrame();
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([parked.key]);
    calls.splice(0);
    await reconnect(setOffline);
    expect(calls).toEqual([]);
    expect(`${card("Rejected Lead")} .o_crm_mobile_pending_sync`).toHaveText("Sync failed");
    // The framework's own cached root loads offline: the reloads after both lead
    // discards.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

// -----------------------------------------------------------------------------
// Queued moves and creates in a stage the pipeline has no group for
// -----------------------------------------------------------------------------

/**
 * Adds the stage "Proposition", which no lead has, after the other stages, and
 * returns its id.
 *
 * @returns {Promise<number>}
 */
async function addEmptyStage() {
    await makeMockServer();
    return MockServer.env["crm.stage"].create({ name: "Proposition", sequence: 4 });
}

/**
 * Makes the mock server refuse a `crm.lead` save naming a stage it no longer
 * holds, as the server refuses to write or create a lead in a deleted stage.
 */
function refuseDeletedStages() {
    onRpc("crm.lead", "web_save", function ({ args }) {
        const stageId = args[1]?.stage_id;
        if (stageId && !this.env["crm.stage"].search_count([["id", "=", stageId]])) {
            throw makeServerError({
                type: "MissingError",
                message: "Record does not exist or has been deleted.",
            });
        }
    });
}

/** Count and revenue sum of the server's leads in a stage, as its header shows them. */
function serverStageTotals(stageId) {
    const leads = MockServer.env["crm.lead"].search_read(
        [["stage_id", "=", stageId]],
        ["expected_revenue"]
    );
    return [leads.length, leads.reduce((sum, lead) => sum + lead.expected_revenue, 0)];
}

/** Discards the first queued call listed in the offline systray, confirmed. */
async function discardFirstQueuedCall() {
    if (!queryFirst(".o_offline_systray_content")) {
        await contains("div.o_nav_entry.o_offline_systray").click();
    }
    await contains(
        ".o_offline_systray_content button[title='Discard offline changes']:first"
    ).click();
    await contains(".modal-dialog .modal-footer button.btn-primary").click();
    await animationFrame();
}

test.tags("mobile");
test("mobile pipeline keeps a lead whose parked move targets a deleted stage in its server stage", async () => {
    const propositionId = await addEmptyStage();
    expandStageGroups();
    refuseDeletedStages();
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    const select = `${card("Desk Upgrade")} .o_crm_mobile_lead_stage`;
    const badge = `${card("Desk Upgrade")} .o_crm_mobile_pending_sync`;
    expect(queryAllTexts(`${select} option`)).toEqual(["New", "Qualified", "Won", "Proposition"]);

    // Offline, the card moves the lead to "Proposition", which is then deleted on
    // the server: the replay of the move is refused, and the move is parked.
    await setOffline(true);
    await contains(select).select(String(propositionId));
    expect(headerTexts()).toEqual(["New", "2", "$ 300"]);
    MockServer.env["crm.stage"].unlink([propositionId]);
    await reconnect(setOffline);
    const [parked] = queued("crm.lead");
    expect(queued("crm.lead")).toHaveLength(1);
    expect([parked.method, parked.args]).toEqual(["web_save", [[3], { stage_id: propositionId }]]);
    expect(parked.extras.error).toInclude("Record does not exist or has been deleted.");
    // Until the search changes or an offline change is discarded online, the
    // framework keeps the column of the stage it displayed, emptied: the lead is
    // still shown in it, with "Sync failed".
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Proposition", "1", "$ 300"]);
    expect(cardNames()).toEqual(["Desk Upgrade"]);
    expect(badge).toHaveText("Sync failed");

    // Reloaded, the pipeline has no group for the deleted stage: the lead keeps its
    // card in its server stage, with "Sync failed", and the header of that stage
    // shows the server's count and revenue.
    await openAction(ACTION_ID);
    expect(serverStageTotals(NEW)).toEqual([3, 600]);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(badge).toHaveText("Sync failed");
    // Its selector shows the stage of the parked move as its current, unselectable
    // option, and offers the stages the pipeline shows.
    expect(select).toHaveValue("");
    expect(`${select} option[disabled]`).toHaveText("Proposition");
    expect(queryAllTexts(`${select} option:not([disabled])`)).toEqual(["New", "Qualified", "Won"]);
    // No other stage shows or counts it.
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
    expect(cardNames()).toEqual(["Conference Room", "Lamps", "Storage Racks"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Won", "1", "$ 900"]);
    expect(cardNames()).toEqual(["Signed Deal"]);
    expect(".o_crm_mobile_pipeline_next").not.toBeEnabled();
    await contains(".o_crm_mobile_pipeline_prev").click();
    await contains(".o_crm_mobile_pipeline_prev").click();

    // Discarded in the offline systray: the card shows its server stage, unbadged.
    await discardFirstQueuedCall();
    expect(queued("crm.lead")).toEqual([]);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(badge).toHaveCount(0);
    expect(select).toHaveValue(String(NEW));
    expect(`${select} option[disabled]`).toHaveCount(0);
});

test.tags("mobile");
test("mobile pipeline counts a lead whose parked move targets a deleted stage in its server stage while a progress bar filters", async () => {
    const propositionId = await addEmptyStage();
    // Two planned leads in "New": "Office Design" and "Desk Upgrade".
    MockServer.env["crm.lead"].write([3], { activity_state: "planned" });
    expandStageGroups();
    refuseDeletedStages();
    onRpc("crm.lead", "get_rainbowman_message", () => false);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    const badge = `${card("Desk Upgrade")} .o_crm_mobile_pending_sync`;

    // A progress-bar filter selected on a wide screen stays active on the phone.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    await contains(".o_kanban_group:first .progress-bar.bg-success").click();
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "2", null]);
    expect(cardNames()).toEqual(["Office Design", "Desk Upgrade"]);

    // Offline, the card moves "Desk Upgrade" to "Proposition", which is then deleted
    // on the server: the replay of the move is refused, and the move is parked.
    await setOffline(true);
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(
        String(propositionId)
    );
    expect(headerTexts()).toEqual(["New", "1", null]);
    MockServer.env["crm.stage"].unlink([propositionId]);
    await reconnect(setOffline);
    expect(queued("crm.lead")[0].extras.error).toInclude(
        "Record does not exist or has been deleted."
    );

    // Back from a lead form, the pipeline loads anew, with its progress-bar filter
    // and without the deleted stage: the filtered count is the server's, and the
    // lead counts, and shows, in its stage.
    await visitLead("Office Design");
    await animationFrame();
    expect(queryAllTexts(`${card("Office Design")} .o_crm_mobile_lead_stage option`)).toEqual([
        "New",
        "Qualified",
        "Won",
    ]);
    expect(headerTexts()).toEqual(["New", "2", null]);
    expect(textOf(HEADER_STATUS)).toBe("Leads: 2");
    expect(cardNames()).toEqual(["Office Design", "Desk Upgrade"]);
    expect(badge).toHaveText("Sync failed");

    // Discarded in the offline systray: the same count, unbadged.
    await discardFirstQueuedCall();
    expect(queued("crm.lead")).toEqual([]);
    expect(headerTexts()).toEqual(["New", "2", null]);
    expect(cardNames()).toEqual(["Office Design", "Desk Upgrade"]);
    expect(badge).toHaveCount(0);
});

test.tags("mobile");
test("[Offline] mobile pipeline keeps a lead whose pending move targets a stage without group in its server stage", async () => {
    expect.errors(3);
    const propositionId = await addEmptyStage();
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    const select = `${card("Desk Upgrade")} .o_crm_mobile_lead_stage`;
    const badge = `${card("Desk Upgrade")} .o_crm_mobile_pending_sync`;
    // No lead has "Proposition": the pipeline has no group for it.
    expect(queryAllTexts(`${select} option`)).toEqual(["New", "Qualified", "Won"]);
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_open`).click();

    // Offline, the lead form moves the lead to "Proposition": the save is queued.
    await setOffline(true);
    await contains(STAGE_DROPDOWN_TOGGLE).click();
    await contains(".o-dropdown--menu .dropdown-item:contains(Proposition)").click();
    await contains(".o_form_button_save").click();
    expect(queued("crm.lead").map(({ method, args }) => [method, args])).toEqual([
        ["web_save", [[3], { stage_id: propositionId }]],
    ]);

    // Back in the pipeline, reloaded from the cache: the lead keeps its card in its
    // server stage, with "Pending sync", counted there and nowhere else.
    await contains(".o_back_button").click();
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(badge).toHaveText("Pending sync");
    expect(select).toHaveValue("");
    expect(`${select} option[disabled]`).toHaveText("Proposition");
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
    expect(cardNames()).toEqual(["Conference Room", "Lamps", "Storage Racks"]);
    await contains(".o_crm_mobile_pipeline_prev").click();

    // Its card moves it back to the stage holding it: the choice is queued after the
    // form's write, so it wins on replay.
    await contains(select).select(String(NEW));
    expect(queued("crm.lead").map(({ method, args }) => [method, args])).toEqual([
        ["web_save", [[3], { stage_id: propositionId }]],
        ["web_save", [[3], { stage_id: NEW }]],
    ]);
    expect(select).toHaveValue(String(NEW));
    expect(badge).toHaveText("Pending sync");
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);

    // Both discarded in the offline systray: the card shows the server values again.
    await discardFirstQueuedCall();
    await discardFirstQueuedCall();
    expect(queued("crm.lead")).toEqual([]);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(badge).toHaveCount(0);
    expect(select).toHaveValue(String(NEW));
    // The framework's own cached pipeline loads offline: back from the form, and the
    // reload after each discard.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile pipeline shows a parked create whose stage was deleted in its first stage", async () => {
    const propositionId = await addEmptyStage();
    expandStageGroups();
    refuseDeletedStages();
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    const orphan = card("Orphan Lead");

    // Offline, a lead created in "Proposition", which is then deleted on the server:
    // the replay of the create is refused, and the create is parked.
    await setOffline(true);
    await quickCreateLead({ name: "Orphan Lead", revenue: 70, stageId: propositionId });
    expect(headerTexts()).toEqual(["Proposition", "1", "$ 70"]);
    expect(cardNames()).toEqual(["Orphan Lead"]);
    MockServer.env["crm.stage"].unlink([propositionId]);
    await reconnect(setOffline);
    const [parked] = queued("crm.lead");
    expect(queued("crm.lead")).toHaveLength(1);
    expect([parked.method, parked.args[0], parked.args[1].stage_id]).toEqual([
        "web_save",
        [],
        propositionId,
    ]);
    expect(parked.extras.error).toInclude("Record does not exist or has been deleted.");
    expect(MockServer.env["crm.lead"].search_count([["name", "=", "Orphan Lead"]])).toBe(0);

    // Reloaded, the pipeline has no group for the deleted stage: the provisional card
    // shows in the first stage, after its leads, with "Sync failed", and that
    // stage's header counts it once.
    await openAction(ACTION_ID);
    expect(headerTexts()).toEqual(["New", "4", "$ 670"]);
    expect(cardNames()).toEqual([
        "Office Design",
        "Quote for Chairs",
        "Desk Upgrade",
        "Orphan Lead",
    ]);
    expect(orphan).toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(`${orphan} .o_crm_mobile_pending_sync`).toHaveText("Sync failed");
    expect(`${orphan} .o_crm_mobile_lead_open`).toHaveAttribute("disabled");
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
    expect(cardNames()).toEqual(["Conference Room", "Lamps", "Storage Racks"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Won", "1", "$ 900"]);
    expect(cardNames()).toEqual(["Signed Deal"]);
    await contains(".o_crm_mobile_pipeline_prev").click();
    await contains(".o_crm_mobile_pipeline_prev").click();

    // Discarded in the offline systray: the first stage shows the server values.
    await discardFirstQueuedCall();
    expect(queued("crm.lead")).toEqual([]);
    expect(orphan).toHaveCount(0);
    expect(serverStageTotals(NEW)).toEqual([3, 600]);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
});

test.tags("mobile");
test("mobile pipeline hides the empty-data helper while a parked create whose stage was deleted shows", async () => {
    const propositionId = await addEmptyStage();
    expandStageGroups();
    refuseDeletedStages();
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    // A search no lead matches: the stages are listed, empty, with the helper.
    const openEmptySearch = () =>
        getService("action").doAction(
            {
                type: "ir.actions.act_window",
                res_model: "crm.lead",
                views: [
                    [false, "kanban"],
                    [false, "form"],
                ],
                domain: OFFLINE_LEAD_DOMAIN,
                context: PIPELINE_CONTEXT,
                cache: true,
            },
            { clearBreadcrumbs: true }
        );
    await openEmptySearch();
    expect(ROOT_HELPER).toHaveCount(1);

    // Offline, a lead created in "Proposition", deleted on the server before the
    // replay, which parks the create.
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 70, stageId: propositionId });
    MockServer.env["crm.stage"].unlink([propositionId]);
    await reconnect(setOffline);
    expect(queued("crm.lead")[0].extras.error).toInclude(
        "Record does not exist or has been deleted."
    );

    // Reloaded: the provisional card shows in the first stage instead of the helper.
    await openEmptySearch();
    expect(headerTexts()).toEqual(["New", "1", "$ 70"]);
    expect(cardNames()).toEqual(["Offline Lead"]);
    expect(`${card("Offline Lead")} .o_crm_mobile_pending_sync`).toHaveText("Sync failed");
    expect(".o_view_nocontent").toHaveCount(0);

    // Discarded in the offline systray: empty again, with the helper.
    await discardFirstQueuedCall();
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(headerTexts()).toEqual(["New", "0", "$ 0"]);
    expect(ROOT_HELPER).toHaveCount(1);
});

// -----------------------------------------------------------------------------
// Refine D2.2 (U2)
// A stage deleted on the server leaves every stage list at the root reload that
// follows a discard in the offline systray.
// -----------------------------------------------------------------------------

/**
 * Names of the stages the stage navigation reaches, first to last: the first
 * stage is shown, then each next one. The last stage is shown afterwards.
 *
 * @returns {Promise<string[]>}
 */
async function navigatedStageNames() {
    while (queryFirst(".o_crm_mobile_pipeline_prev:enabled")) {
        await contains(".o_crm_mobile_pipeline_prev").click();
    }
    const names = [textOf(STAGE_NAME)];
    while (queryFirst(".o_crm_mobile_pipeline_next:enabled")) {
        await contains(".o_crm_mobile_pipeline_next").click();
        names.push(textOf(STAGE_NAME));
    }
    return names;
}

/**
 * Shows the stage named `name` through the stage navigation, from the first stage.
 *
 * @param {string} name
 */
async function showStageNamed(name) {
    while (queryFirst(".o_crm_mobile_pipeline_prev:enabled")) {
        await contains(".o_crm_mobile_pipeline_prev").click();
    }
    while (textOf(STAGE_NAME) !== name) {
        await contains(".o_crm_mobile_pipeline_next:enabled").click();
    }
}

/**
 * Names of the stages the quick-create sheet offers, read from a sheet opened on
 * the displayed stage and closed again.
 *
 * @returns {Promise<string[]>}
 */
async function quickCreateStageNames() {
    await contains(".o_crm_mobile_pipeline_new").click();
    const names = queryAllTexts(`${QUICK_CREATE_STAGE} option`);
    await contains(".o_crm_mobile_quick_create_cancel").click();
    await animationFrame();
    expect("form.o_crm_mobile_quick_create").toHaveCount(0);
    return names;
}

test.tags("mobile");
test("mobile pipeline lists no stage deleted on the server after a discard reload", async () => {
    const propositionId = await addEmptyStage();
    const [negotiationId] = MockServer.env["crm.stage"].create([
        { name: "Negotiation", sequence: 5 },
        { name: "Closing", sequence: 6 },
    ]);
    expandStageGroups();
    refuseDeletedStages();
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    const allStages = ["New", "Qualified", "Won", "Proposition", "Negotiation", "Closing"];
    const stageOptions = (name) => queryAllTexts(`${card(name)} .o_crm_mobile_lead_stage option`);
    expect(stageOptions("Office Design")).toEqual(allStages);

    // Offline, a card moves "Desk Upgrade" to "Proposition" and a lead is created in
    // it; the stage is then deleted on the server, so both replays are refused and
    // parked. The replay reload keeps the stage the framework displayed, emptied.
    await setOffline(true);
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(
        String(propositionId)
    );
    await quickCreateLead({ name: "Orphan Lead", revenue: 70, stageId: propositionId });
    MockServer.env["crm.stage"].unlink([propositionId]);
    await reconnect(setOffline);
    expect(queued("crm.lead").map(({ extras }) => Boolean(extras.error))).toEqual([true, true]);
    expect(headerTexts()).toEqual(["Proposition", "2", "$ 370"]);

    // Shown on the stage after it, then the move is discarded online: the reload
    // lists the stages the server lists, and the stage shown stays shown.
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Negotiation", "0", "$ 0"]);
    const calls = trackCalls();
    await discardFirstQueuedCall();
    expect(queued("crm.lead")).toHaveLength(1);
    expect(calls).toEqual(["crm.lead/read_progress_bar", "crm.lead/web_read_group"]);
    expect(headerTexts()).toEqual(["Negotiation", "0", "$ 0"]);
    expect(".o_crm_mobile_pipeline_next").toBeEnabled();
    const remaining = ["New", "Qualified", "Won", "Negotiation", "Closing"];
    expect(await navigatedStageNames()).toEqual(remaining);
    expect(".o_crm_mobile_pipeline_next").not.toBeEnabled();
    await showStageNamed("New");
    // The lead of the discarded move shows in its server stage, which lists the
    // parked create of the deleted stage after its leads, with "Sync failed".
    expect(headerTexts()).toEqual(["New", "4", "$ 670"]);
    expect(cardNames()).toEqual([
        "Office Design",
        "Quote for Chairs",
        "Desk Upgrade",
        "Orphan Lead",
    ]);
    expect(`${card("Desk Upgrade")} .o_crm_mobile_pending_sync`).toHaveCount(0);
    expect(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).toHaveValue(String(NEW));
    expect(`${card("Orphan Lead")} .o_crm_mobile_pending_sync`).toHaveText("Sync failed");
    // Neither the card stage selectors nor the quick create offer the deleted stage.
    expect(stageOptions("Office Design")).toEqual(remaining);
    expect(stageOptions("Desk Upgrade")).toEqual(remaining);
    expect(await quickCreateStageNames()).toEqual(remaining);

    // The stage shown is deleted on the server, then the create is discarded online:
    // the stage now at its place, the last one, is shown.
    await showStageNamed("Negotiation");
    MockServer.env["crm.stage"].unlink([negotiationId]);
    await discardFirstQueuedCall();
    expect(queued("crm.lead")).toEqual([]);
    expect(headerTexts()).toEqual(["Closing", "0", "$ 0"]);
    expect(".o_crm_mobile_pipeline_next").not.toBeEnabled();
    const lastStages = ["New", "Qualified", "Won", "Closing"];
    expect(await navigatedStageNames()).toEqual(lastStages);
    await showStageNamed("New");
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(stageOptions("Desk Upgrade")).toEqual(lastStages);
    expect(await quickCreateStageNames()).toEqual(lastStages);
});

test.tags("mobile");
test("[Offline] mobile pipeline keeps the cached stages at a discard reload", async () => {
    expect.errors(1);
    const propositionId = await addEmptyStage();
    expandStageGroups();
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    const allStages = ["New", "Qualified", "Won", "Proposition"];

    // Offline, a move is discarded after the stage was deleted on the server: the
    // root reloads from the cache, which still holds the stage.
    await setOffline(true);
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    MockServer.env["crm.stage"].unlink([propositionId]);
    await showStageNamed("Proposition");
    const calls = trackCalls();
    await discardFirstQueuedCall();
    expect(queued("crm.lead")).toEqual([]);
    expect(calls).toEqual(["crm.lead/read_progress_bar", "crm.lead/web_read_group"]);
    expect(headerTexts()).toEqual(["Proposition", "0", "$ 0"]);
    expect(await navigatedStageNames()).toEqual(allStages);
    await showStageNamed("New");
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(queryAllTexts(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage option`)).toEqual(
        allStages
    );
    // The framework's own cached root load offline: the reload after the discard.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

test.tags("mobile");
test("mobile pipeline offers no stage deleted on the server on an ungrouped list after a discard reload", async () => {
    const propositionId = await addPropositionStage();
    const stageGroups = expandStageChoices();
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (args[0][0] === 5) {
            throw makeServerError({ message: "Invalid lead" });
        }
    });
    const setOffline = mockOffline();
    const options = (name) => queryAllTexts(`${card(name)} .o_crm_mobile_lead_stage option`);
    await mountWithCleanup(WebClient);
    await openAction(UNGROUPED_LEADS_ACTION_ID);
    await animationFrame();
    expect(stageGroups).toHaveLength(1);
    expect(options("Lamps")).toEqual(STAGES_IN_ORDER);

    // Offline, a card moves "Lamps", whose replay the server refuses: it is parked.
    await setOffline(true);
    await contains(`${card("Lamps")} .o_crm_mobile_lead_stage`).select(String(NEW));
    await reconnect(setOffline);
    expect(queued("crm.lead")[0].extras.error).toInclude("Invalid lead");
    expect(`${card("Lamps")} .o_crm_mobile_pending_sync`).toHaveText("Sync failed");

    // "Proposition" is deleted on the server, then the move is discarded online: the
    // stage choices are read again with the root, without the deleted stage.
    MockServer.env["crm.stage"].unlink([propositionId]);
    await discardFirstQueuedCall();
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(stageGroups).toHaveLength(2);
    expect(stageGroups[1].context.read_group_expand).toBe(true);
    expect(options("Lamps")).toEqual(["New", "Qualified", "Won"]);
    expect(options("Office Design")).toEqual(["New", "Qualified", "Won"]);
    expect(`${card("Lamps")} .o_crm_mobile_lead_stage`).toHaveValue(String(QUALIFIED));
    expect(`${card("Lamps")} .o_crm_mobile_pending_sync`).toHaveCount(0);
});

// -----------------------------------------------------------------------------
// Replay hold: what the replay has just sent shows until the views reload
// -----------------------------------------------------------------------------

/**
 * Holds the `model`/`method` requests the mock server receives between `hold()`
 * and `stop()`: each waits until `release()`, then is answered as usual.
 *
 * @param {string} model
 * @param {string} method
 * @returns {{hold: () => void, stop: () => void, release: () => void, size: number}}
 *  `size`: the number of requests held and not answered yet
 */
function holdRequests(model, method) {
    const held = [];
    let holding = false;
    onRpc(model, method, () => {
        if (holding) {
            const deferred = Promise.withResolvers();
            held.push(deferred);
            return deferred.promise;
        }
    });
    return {
        hold() {
            holding = true;
        },
        stop() {
            holding = false;
        },
        release() {
            holding = false;
            for (const { resolve } of held.splice(0)) {
                resolve();
            }
        },
        get size() {
            return held.length;
        },
    };
}

/**
 * Records, after each render of an activity sheet, how many of its rows show a
 * `title` activity and the label of the "mark done" button of `activityId`'s
 * row (`null` without that row).
 *
 * @param {string} title
 * @param {number} activityId
 * @returns {{titled: number, done: string|null}[]} the frames, filled as they render
 */
function recordSheetFrames(title, activityId) {
    const frames = [];
    patchWithCleanup(CrmMobileLeadActivities.prototype, {
        setup() {
            super.setup(...arguments);
            onPatched(() =>
                frames.push({
                    titled: activityTitles().filter((text) => text === title).length,
                    done: textOf(`${activityRow(activityId)} .o_crm_mobile_activity_done`),
                })
            );
        },
    });
    return frames;
}

test.tags("mobile");
test("mobile pipeline keeps a replayed create's card and header totals until its reconciliation reload shows the lead", async () => {
    const frames = [];
    const displayed = () => ({
        cards: queryAll(card("Offline Lead")).map((el) =>
            el.classList.contains("o_crm_mobile_lead_card_provisional") ? "provisional" : "server"
        ),
        header: headerTexts(),
        status: textOf(HEADER_STATUS),
    });
    patchWithCleanup(CrmMobilePipeline.prototype, {
        setup() {
            super.setup(...arguments);
            onPatched(() => frames.push(displayed()));
        },
    });
    const groups = holdRequests("crm.lead", "web_read_group");
    const progressBars = holdRequests("crm.lead", "read_progress_bar");
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    const header = ["New", "4", "$ 650"];
    const status = "Leads: 4, expected revenue: $ 650";
    expect(displayed()).toEqual({ cards: ["provisional"], header, status });

    // The create is replayed and leaves the queue, while the reconciliation reload
    // waits for its groups and its progress bar: the provisional card, the count,
    // the revenue and the status region stay as they were.
    groups.hold();
    progressBars.hold();
    frames.splice(0);
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].search_count([["name", "=", "Offline Lead"]])).toBe(1);
    expect(groups.size).toBe(1);
    expect(progressBars.size).toBe(1);
    expect(displayed()).toEqual({ cards: ["provisional"], header, status });
    expect(`${card("Offline Lead")} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");

    // The groups arrive: the reloaded root shows the lead as a server card, in the
    // same render that drops the provisional one; the totals do not move.
    groups.release();
    await animationFrame();
    expect(displayed()).toEqual({ cards: ["server"], header, status });
    progressBars.release();
    await animationFrame();
    await animationFrame();
    expect(displayed()).toEqual({ cards: ["server"], header, status });
    expect(`${card("Offline Lead")} .o_crm_mobile_pending_sync`).toHaveCount(0);
    expect(cardNames()).toEqual([
        "Office Design",
        "Quote for Chairs",
        "Desk Upgrade",
        "Offline Lead",
    ]);

    // No render in between showed the lead twice or not at all, or other totals.
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
        expect(frame.cards).toHaveLength(1);
        expect(frame.header).toEqual(header);
        expect(frame.status).toBe(status);
    }
});

test.tags("mobile");
test("mobile activities: a sheet open across reconnection keeps its replayed call and completion until the pipeline reloads", async () => {
    const frames = recordSheetFrames("Call", 2);
    const groups = holdRequests("crm.lead", "web_read_group");
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await openActivities("Office Design");
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    await contains(`${activityRow(2)} .o_crm_mobile_activity_done`).click();
    expect(queued("mail.activity").map(({ method }) => method)).toEqual(["create", "action_done"]);

    // Both calls are replayed and leave the queue, while the pipeline's reload
    // waits: the call stays a pending row, and the completion stays pending.
    groups.hold();
    frames.splice(0);
    await reconnect(setOffline);
    expect(queued("mail.activity")).toEqual([]);
    expect(groups.size).toBe(1);
    const [call] = MockServer.env["mail.activity"].search_read(
        [
            ["res_id", "=", 1],
            ["summary", "=", "Call"],
        ],
        ["id"]
    );
    expect(MockServer.env["mail.activity"].search_count([["id", "=", 2]])).toBe(0);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure", "Call"]);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Call");
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_pending_sync").toHaveText("Pending sync");
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).toHaveText("Done · Pending sync");
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).not.toBeEnabled();

    // The reload shows the server's rows: the call is a synced row with its own
    // done button, and the completed activity is gone.
    groups.release();
    await animationFrame();
    await animationFrame();
    expect(".o_crm_mobile_activity_pending").toHaveCount(0);
    expect(activityRow(2)).toHaveCount(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Call"]);
    expect(`${activityRow(call.id)} .o_crm_mobile_activity_done`).toHaveText("Mark done");
    expect(`${activityRow(call.id)} .o_crm_mobile_activity_done`).toBeEnabled();

    // No render in between dropped the call or re-enabled "Mark done" of the
    // completed activity.
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
        expect(frame.titled).toBe(1);
        expect(frame.done).not.toBe("Mark done");
    }
});

test.tags("mobile");
test("mobile activities: an activity delivered before the connection drops mid-replay stays listed until a reload shows it", async () => {
    const setOffline = mockOffline();
    const drops = dropConnections();
    // Once the call is delivered, the connection drops on the next replayed call.
    onRpc("mail.activity", "create", () => {
        drops.add("crm.lead/web_save");
    });
    const calls = trackCalls();
    await mountPipeline();
    const plugin = getService(OfflinePlugin);
    await setOffline(true);
    await openActivities("Office Design");
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    await closeSheet();
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    await openActivities("Office Design");
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Call");

    // The replay delivers the call, then the connection drops: the sync ends offline,
    // with the move still queued and no reconciliation.
    calls.splice(0);
    await setOffline(false);
    for (let i = 0; i < 5 && plugin.syncingORM(); i++) {
        await advanceTime(1000);
    }
    await animationFrame();
    expect(drops.size).toBe(0);
    expect(plugin.isOffline()).toBe(true);
    expect(calls).toEqual(["mail.activity/create", "crm.lead/web_save"]);
    expect(queued("mail.activity")).toEqual([]);
    expect(queued("crm.lead").map(({ args }) => args[0])).toEqual([[3]]);
    const delivered = () =>
        MockServer.env["mail.activity"].search_read(
            [
                ["res_id", "=", 1],
                ["summary", "=", "Call"],
            ],
            ["id"]
        );
    expect(delivered()).toHaveLength(1);

    // Offline, the delivered call stays listed, as pending, in the open sheet and
    // in the sheet opened again: it is not logged twice.
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure", "Call"]);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_pending_sync").toHaveText("Pending sync");
    await closeSheet();
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure", "Call"]);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Call");

    // The next sync replays the move and ends online: the reload shows the call as a
    // synced row, which was created once.
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    const [call] = delivered();
    expect(delivered()).toHaveLength(1);
    expect(".o_crm_mobile_activity_pending").toHaveCount(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure", "Call"]);
    expect(`${activityRow(call.id)} .o_crm_mobile_activity_done`).toBeEnabled();
    expect(calls.filter((name) => name === "mail.activity/create")).toHaveLength(1);
});

test.tags("mobile");
test("mobile activities: an activity delivered before a mid-replay drop stays pending through an offline reload, until a sync with nothing left to replay", async () => {
    expect.errors(1);
    const setOffline = mockOffline();
    const drops = dropConnections();
    // Once the call is delivered, the connection drops on the next replayed call.
    onRpc("mail.activity", "create", () => {
        drops.add("crm.lead/web_save");
    });
    const calls = trackCalls();
    await mountPipeline();
    const plugin = getService(OfflinePlugin);
    await setOffline(true);
    await openActivities("Office Design");
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    await closeSheet();
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));

    // The replay delivers the call, then the connection drops (and stays down).
    await setOffline(false);
    for (let i = 0; i < 5 && plugin.syncingORM(); i++) {
        await advanceTime(1000);
    }
    await setOffline(true);
    expect(drops.size).toBe(0);
    expect(plugin.isOffline()).toBe(true);
    expect(queued("mail.activity")).toEqual([]);
    const [move] = queued("crm.lead");
    expect(move.args[0]).toEqual([3]);

    // The move is discarded: the pipeline reloads from the cache, whose root predates
    // the call, which stays pending.
    plugin.removeScheduledORM(move.key);
    await animationFrame();
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure", "Call"]);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_pending_sync").toHaveText("Pending sync");

    // The next sync, with nothing left to replay, ends online and reloads: the call is a
    // synced row, created once.
    calls.splice(0);
    await reconnect(setOffline);
    expect(calls.filter((name) => name === "crm.lead/web_read_group")).toEqual([
        "crm.lead/web_read_group",
    ]);
    expect(calls.filter((name) => WRITE_CALL.test(name))).toEqual([]);
    const [call] = MockServer.env["mail.activity"].search_read(
        [
            ["res_id", "=", 1],
            ["summary", "=", "Call"],
        ],
        ["id"]
    );
    expect(".o_crm_mobile_activity_pending").toHaveCount(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure", "Call"]);
    expect(`${activityRow(call.id)} .o_crm_mobile_activity_done`).toBeEnabled();
    // The framework's own cached root load offline (the reload after the discard).
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

test.tags("mobile");
test("mobile pipeline redoes at the next sync end a reconciliation lost with the connection", async () => {
    const setOffline = mockOffline();
    // Once the create is delivered, the connection is lost (every request fails as a
    // dropped connection) until the test restores it.
    let connectionLost = false;
    onRpc("/*", () => {
        if (connectionLost) {
            return new Response("", { status: 502 });
        }
    });
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (!args[0].length) {
            connectionLost = true;
        }
    });
    // Registered after the lost connection: it also sees the requests that fail.
    const calls = trackCalls();
    await mountPipeline();
    const plugin = getService(OfflinePlugin);
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });

    // The sync ends online, then its reconciliation reload is lost: offline, the
    // provisional card and the totals stay.
    calls.splice(0);
    await reconnect(setOffline);
    expect(plugin.isOffline()).toBe(true);
    expect(queued("crm.lead")).toEqual([]);
    expect(calls.slice(0, 1)).toEqual(["crm.lead/web_save"]);
    expect(calls).toInclude("crm.lead/web_read_group");
    expect(MockServer.env["crm.lead"].search_count([["name", "=", "Offline Lead"]])).toBe(1);
    expect(card("Offline Lead")).toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(headerTexts()).toEqual(["New", "4", "$ 650"]);

    // The connection is back: the next sync end, with nothing to replay, reloads the
    // root, which shows the lead as a server card; the totals do not move.
    connectionLost = false;
    calls.splice(0);
    await reconnect(setOffline);
    expect(plugin.isOffline()).toBe(false);
    expect(calls).toInclude("crm.lead/web_read_group");
    expect(calls.filter((name) => WRITE_CALL.test(name))).toEqual([]);
    expect(card("Offline Lead")).not.toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(cardNames()).toEqual([
        "Office Design",
        "Quote for Chairs",
        "Desk Upgrade",
        "Offline Lead",
    ]);
    expect(headerTexts()).toEqual(["New", "4", "$ 650"]);

    // Reconciled: a later sync with nothing to replay reloads nothing.
    calls.splice(0);
    await setOffline(true);
    await reconnect(setOffline);
    expect(calls).toEqual([]);
});

test.tags("mobile");
test("mobile pipeline redoes at the next sync end a reconciliation reload the server refused", async () => {
    expect.errors(1);
    // The reconciliation reload after the create's replay is refused once.
    let refuseReload = false;
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (!args[0].length) {
            refuseReload = true;
        }
    });
    onRpc("crm.lead", "web_read_group", () => {
        if (refuseReload) {
            refuseReload = false;
            throw makeServerError({ message: "Reload refused" });
        }
    });
    const setOffline = mockOffline();
    const calls = trackCalls();
    await mountPipeline();
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });

    // The create is delivered and its reconciliation reload is refused: the error is
    // reported once, and the provisional card and the totals stay.
    await reconnect(setOffline);
    expect.verifyErrors(["Reload refused"]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].search_count([["name", "=", "Offline Lead"]])).toBe(1);
    expect(card("Offline Lead")).toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(headerTexts()).toEqual(["New", "4", "$ 650"]);

    // The next sync end, with nothing to replay, reloads the root once: the lead is a
    // server card, and the totals do not move.
    calls.splice(0);
    await setOffline(true);
    await reconnect(setOffline);
    expect(calls.filter((name) => name === "crm.lead/web_read_group")).toEqual([
        "crm.lead/web_read_group",
    ]);
    expect(calls.filter((name) => WRITE_CALL.test(name))).toEqual([]);
    expect(card("Offline Lead")).not.toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(queryAll(card("Offline Lead"))).toHaveLength(1);
    expect(headerTexts()).toEqual(["New", "4", "$ 650"]);

    // Reconciled: a later sync with nothing to replay reloads nothing.
    calls.splice(0);
    await setOffline(true);
    await reconnect(setOffline);
    expect(calls).toEqual([]);
    expect.verifyErrors([]);
});

test.tags("mobile");
test("mobile pipeline releases a replayed create once a search superseding its reconciliation shows the lead", async () => {
    let controller = null;
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    const groups = holdRequests("crm.lead", "web_read_group");
    const setOffline = mockOffline();
    const calls = trackCalls();
    await mountPipeline();
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });

    // The reconciliation reload waits for its groups.
    groups.hold();
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(groups.size).toBe(1);
    expect(card("Offline Lead")).toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(headerTexts()).toEqual(["New", "4", "$ 650"]);

    // A search meanwhile supersedes it: once the search's load ends, the lead is a
    // server card, shown once.
    groups.stop();
    controller.env.searchModel.splitAndAddDomain(`[("id", "!=", 0)]`);
    await animationFrame();
    await animationFrame();
    expect(queryAll(card("Offline Lead"))).toHaveLength(1);
    expect(card("Offline Lead")).not.toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(headerTexts()).toEqual(["New", "4", "$ 650"]);

    // The superseded reload's answer changes nothing.
    groups.release();
    await animationFrame();
    await animationFrame();
    expect(cardNames()).toEqual([
        "Office Design",
        "Quote for Chairs",
        "Desk Upgrade",
        "Offline Lead",
    ]);
    expect(card("Offline Lead")).not.toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(headerTexts()).toEqual(["New", "4", "$ 650"]);

    // Nothing is held anymore: a later sync with nothing to replay reloads nothing.
    calls.splice(0);
    await setOffline(true);
    await reconnect(setOffline);
    expect(calls).toEqual([]);
});

test.tags("mobile");
test("mobile activities: the lead form's sheet open across reconnection keeps its replayed call and completion until the form reloads the lead", async () => {
    const frames = recordSheetFrames("Call", 2);
    const reads = holdRequests("crm.lead", "web_read");
    const setOffline = mockOffline();
    await openLeadFormController(1);
    await setOffline(true);
    await contains(".o_crm_mobile_activities_button").click();
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    await contains(`${activityRow(2)} .o_crm_mobile_activity_done`).click();
    expect(queued("mail.activity").map(({ method }) => method)).toEqual(["create", "action_done"]);

    // Both calls are replayed and leave the queue, while the form's reload of its
    // lead waits: the call stays a pending row, and the completion stays pending.
    reads.hold();
    frames.splice(0);
    await reconnect(setOffline);
    expect(queued("mail.activity")).toEqual([]);
    expect(reads.size).toBeGreaterThan(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure", "Call"]);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Call");
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_pending_sync").toHaveText("Pending sync");
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).toHaveText("Done · Pending sync");
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).not.toBeEnabled();

    // The reloaded lead lists the server's rows.
    reads.release();
    await animationFrame();
    await animationFrame();
    const [call] = MockServer.env["mail.activity"].search_read(
        [
            ["res_id", "=", 1],
            ["summary", "=", "Call"],
        ],
        ["id"]
    );
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(".o_crm_mobile_activity_pending").toHaveCount(0);
    expect(activityRow(2)).toHaveCount(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Call"]);
    expect(`${activityRow(call.id)} .o_crm_mobile_activity_done`).toBeEnabled();

    // No render in between dropped the call or re-enabled "Mark done" of the
    // completed activity.
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
        expect(frame.titled).toBe(1);
        expect(frame.done).not.toBe("Mark done");
    }
});

test.tags("mobile");
test("lead form redoes at the next sync end a reconciliation lost with the connection", async () => {
    const setOffline = mockOffline();
    // Once the call is delivered, the connection is lost (every request fails as a
    // dropped connection) until the test restores it.
    let connectionLost = false;
    onRpc("/*", () => {
        if (connectionLost) {
            return new Response("", { status: 502 });
        }
    });
    onRpc("mail.activity", "create", () => {
        connectionLost = true;
    });
    // Registered after the lost connection: it also sees the requests that fail.
    const calls = trackCalls();
    await openLeadFormController(1);
    const plugin = getService(OfflinePlugin);
    await setOffline(true);
    await contains(".o_crm_mobile_activities_button").click();
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();

    // The sync ends online, then the form's reload of its lead is lost: offline, the
    // delivered call stays a pending row of the open sheet.
    calls.splice(0);
    await reconnect(setOffline);
    expect(plugin.isOffline()).toBe(true);
    expect(queued("mail.activity")).toEqual([]);
    expect(calls.slice(0, 2)).toEqual(["mail.activity/create", "crm.lead/web_read"]);
    expect(
        MockServer.env["mail.activity"].search_count([
            ["res_id", "=", 1],
            ["summary", "=", "Call"],
        ])
    ).toBe(1);
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure", "Call"]);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Call");

    // The connection is back: the next sync end, with nothing to replay, reloads the
    // lead, whose server rows show the call as a synced row.
    connectionLost = false;
    calls.splice(0);
    await reconnect(setOffline);
    expect(plugin.isOffline()).toBe(false);
    expect(calls).toInclude("crm.lead/web_read");
    expect(calls.filter((name) => WRITE_CALL.test(name))).toEqual([]);
    const [call] = MockServer.env["mail.activity"].search_read(
        [
            ["res_id", "=", 1],
            ["summary", "=", "Call"],
        ],
        ["id"]
    );
    expect(".o_crm_mobile_activity_pending").toHaveCount(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure", "Call"]);
    expect(`${activityRow(call.id)} .o_crm_mobile_activity_done`).toBeEnabled();

    // Reconciled: a later sync with nothing to replay reloads nothing.
    await closeSheet();
    calls.splice(0);
    await setOffline(true);
    await reconnect(setOffline);
    expect(calls).toEqual([]);
});

test.tags("mobile");
test("lead form keeps a call replayed after the start of a lead reload until a reload started after it ends", async () => {
    // While `held` is set, each lead read is answered from the server state of its
    // arrival, once its deferred (in `held`, in arrival order) is resolved.
    let held = null;
    onRpc("crm.lead", "web_read", async ({ parent }) => {
        if (held) {
            const result = await parent();
            const deferred = Promise.withResolvers();
            held.push(deferred);
            await deferred.promise;
            return result;
        }
    });
    const setOffline = mockOffline();
    const form = await openLeadFormController(1);
    const plugin = getService(OfflinePlugin);
    await setOffline(true);
    await contains(".o_crm_mobile_activities_button").click();
    await contains(`${activityRow(2)} .o_crm_mobile_activity_done`).click();
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    expect(queued("mail.activity").map(({ method }) => method)).toEqual(["action_done", "create"]);

    // The completion is replayed; then, before the call's replay a second later, a
    // reload of the lead reads the server.
    await setOffline(false);
    for (let i = 0; i < 10 && queued("mail.activity").length > 1; i++) {
        await animationFrame();
    }
    expect(queued("mail.activity").map(({ method }) => method)).toEqual(["create"]);
    held = [];
    form.model.root.load();
    await animationFrame();
    expect(held).toHaveLength(1);

    // The call is replayed, and the sync ends: the form's reconciliation waits.
    await advanceTime(1000);
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("mail.activity")).toEqual([]);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Call");

    // The earlier reload ends: read before the call's replay, it does not list the
    // call, which stays pending; the completed activity is gone.
    held[0].resolve();
    await animationFrame();
    await animationFrame();
    expect(activityRow(2)).toHaveCount(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Call"]);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Call");

    // The reconciliation, started after the call's replay, ends: the call is a synced
    // row.
    expect(held).toHaveLength(2);
    const reconciliation = held[1];
    held = null;
    reconciliation.resolve();
    await animationFrame();
    await animationFrame();
    const [call] = MockServer.env["mail.activity"].search_read(
        [
            ["res_id", "=", 1],
            ["summary", "=", "Call"],
        ],
        ["id"]
    );
    expect(".o_crm_mobile_activity_pending").toHaveCount(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Call"]);
    expect(`${activityRow(call.id)} .o_crm_mobile_activity_done`).toBeEnabled();
});

test.tags("mobile");
test("a replay holder failing at the replay is reported once and neither parks the call nor stops the reconciliation", async () => {
    expect.errors(1);
    // The form's holder fails when the replay hands it the call it has just sent:
    // its `accept` reads `isSmall`, which then throws once.
    let failingKey = null;
    patchWithCleanup(CrmFormController.prototype, {
        setup() {
            super.setup(...arguments);
            const crmOffline = this.crmOffline;
            this.crmOffline = Object.create(crmOffline, {
                isSmall: {
                    get() {
                        const plugin = getService(OfflinePlugin);
                        if (
                            failingKey &&
                            plugin.syncingORM() &&
                            !(failingKey in plugin._ormToSync())
                        ) {
                            failingKey = null;
                            throw new Error("Holder failed");
                        }
                        return crmOffline.isSmall;
                    },
                },
            });
        },
    });
    const received = receivedCalls("mail.activity", "create");
    const setOffline = mockOffline();
    await openLeadFormController(1);
    await setOffline(true);
    await contains(".o_crm_mobile_activities_button").click();
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    const [create] = queued("mail.activity");
    failingKey = create.key;

    // The call is replayed once and not parked; the form still reloads its lead,
    // which lists the call as a synced row.
    await reconnect(setOffline);
    expect(failingKey).toBe(null);
    expect.verifyErrors(["Holder failed"]);
    expect(queued("mail.activity")).toEqual([]);
    expect(received).toHaveLength(1);
    const [call] = MockServer.env["mail.activity"].search_read(
        [
            ["res_id", "=", 1],
            ["summary", "=", "Call"],
        ],
        ["id"]
    );
    expect(".o_crm_mobile_activity_pending").toHaveCount(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure", "Call"]);
    expect(`${activityRow(call.id)} .o_crm_mobile_activity_done`).toBeEnabled();
});

test.tags("mobile");
test("[Offline] New Lead deep link opens the mobile quick create from cache", async () => {
    expect.errors(2);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    // A normal online visit caches the pipeline; the flag is not set: no sheet.
    await openAction(ACTION_ID);
    expect(".o_bottom_sheet").toHaveCount(0);

    // "New Lead" shortcut opened offline: the pipeline is served from the cache and
    // the quick-create sheet opens once, on the displayed stage.
    await setOffline(true);
    patchWithCleanup(quickCreateDeepLink, {
        pending: isQuickCreateDeepLink("?menu_id=1&crm_quick_create=1"),
    });
    await openAction(ACTION_ID);
    await animationFrame();
    expect(".o_bottom_sheet form.o_crm_mobile_quick_create").toHaveCount(1);
    expect("form.o_crm_mobile_quick_create select[name=stage_id]").toHaveValue(String(NEW));
    expect(quickCreateDeepLink.pending).toBe(false);
    await contains("form.o_crm_mobile_quick_create input[name=name]").edit("Shortcut Lead", {
        confirm: false,
    });
    await contains(".o_crm_mobile_quick_create_save").click();
    expect(".o_bottom_sheet").toHaveCount(0);
    const [create] = queued("crm.lead");
    expect(create.method).toBe("web_save");
    expect(create.args[0]).toEqual([]);
    expect(create.args[1].name).toBe("Shortcut Lead");
    expect(create.kwargs.context.default_type).toBe("opportunity");
    expect(".o_crm_mobile_lead_card_provisional .o_crm_mobile_lead_name").toHaveText(
        "Shortcut Lead"
    );

    // Once only: reopening the pipeline opens no sheet.
    await openAction(ACTION_ID);
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    // The framework's cached root load, once per offline opening of the pipeline.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("New Lead deep link: only crm_quick_create=1 opens the quick create, once", async () => {
    patchWithCleanup(quickCreateDeepLink, { pending: false });
    await mountWithCleanup(WebClient);

    // Any other value, or no flag at all, opens no sheet.
    for (const search of [
        "?menu_id=1&crm_quick_create=0",
        "?menu_id=1&crm_quick_create=false",
        "?menu_id=1&crm_quick_create=",
        "?menu_id=1&crm_quick_create=yes",
        "?menu_id=1",
    ]) {
        quickCreateDeepLink.pending = isQuickCreateDeepLink(search);
        await openAction(ACTION_ID);
        await animationFrame();
        expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
        expect(".o_bottom_sheet").toHaveCount(0, { message: search });
    }

    // The shortcut's value opens the sheet once: the consumed flag opens no other.
    quickCreateDeepLink.pending = isQuickCreateDeepLink("?menu_id=1&crm_quick_create=1");
    await openAction(ACTION_ID);
    await animationFrame();
    expect(".o_bottom_sheet form.o_crm_mobile_quick_create").toHaveCount(1);
    expect(quickCreateDeepLink.pending).toBe(false);
    await contains(".o_crm_mobile_quick_create_cancel").click();
    expect(".o_bottom_sheet").toHaveCount(0);
    await openAction(ACTION_ID);
    await animationFrame();
    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    expect(".o_bottom_sheet").toHaveCount(0);
});

/**
 * Emulates the server's stage group expansion, which the mock server lacks: a
 * `crm.lead` `formatted_read_group` by `stage_id` with `read_group_expand` in its
 * context answers one group per `crm.stage`, in stage order (`sequence`, then
 * `id`), as `_read_group_stage_ids` does for stages of no sales team. Records the
 * kwargs of every `crm.lead` `formatted_read_group` it answers or passes on.
 *
 * @returns {Object[]} the recorded kwargs, in arrival order
 */
function expandStageChoices() {
    const requests = [];
    onRpc("crm.lead", "formatted_read_group", function expandStages({ kwargs }) {
        requests.push(JSON.parse(JSON.stringify(kwargs)));
        if (!kwargs.context?.read_group_expand || kwargs.groupby[0] !== "stage_id") {
            return;
        }
        return this.env["crm.stage"]
            .search_read([], ["display_name", "sequence"])
            .sort((a, b) => a.sequence - b.sequence || a.id - b.id)
            .map((stage) => ({
                stage_id: [stage.id, stage.display_name],
                __extra_domain: [["stage_id", "=", stage.id]],
            }));
    });
    return requests;
}

/**
 * Adds the stage "Proposition", which no lead has, before "Won" (moved last), as
 * in the CRM stage data: in stage order it comes third, in id order last.
 *
 * @returns {Promise<number>} its id
 */
async function addPropositionStage() {
    await makeMockServer();
    MockServer.env["crm.stage"].write([WON], { sequence: 4 });
    return MockServer.env["crm.stage"].create({ name: "Proposition", sequence: 3 });
}

/** Stages of the grouped Leads list once "Proposition" is added, in stage order. */
const STAGES_IN_ORDER = ["New", "Qualified", "Proposition", "Won"];

/** Domain of an ungrouped Leads search: every lead of the mock is an opportunity. */
const OPPORTUNITY_DOMAIN = [["type", "=", "opportunity"]];

test.tags("mobile");
test("mobile pipeline lists ungrouped leads with the stages of the grouped list", async () => {
    await addPropositionStage();
    const stageGroups = expandStageChoices();
    const setOffline = mockOffline();
    const specs = rootSpecs();
    await mountPipeline({ arch: leadsArch, groupBy: [], domain: OPPORTUNITY_DOMAIN });
    await animationFrame();
    expect(".o_crm_mobile_pipeline.o_crm_mobile_pipeline_ungrouped").toHaveCount(1);
    expect(".o_crm_mobile_pipeline_header").toHaveCount(0);
    expect(specs.map(({ method }) => method)).toEqual(["web_search_read"]);
    // The mobile variant loads the stage the Leads arch lacks, and the activity rows.
    expect("stage_id" in specs[0].specification).toBe(true);
    expect(Object.keys(specs[0].specification.activity_ids.fields)).toEqual(ACTIVITY_SUBFIELDS);
    expect(cardNames()).toEqual([
        "Office Design",
        "Quote for Chairs",
        "Desk Upgrade",
        "Conference Room",
        "Lamps",
        "Storage Racks",
        "Signed Deal",
    ]);
    // The stage choices are the stages the list shows when grouped by stage: the
    // server's stage groups of the list's search with group expansion, in stage
    // order, a stage without lead included.
    expect(stageGroups).toHaveLength(1);
    const [request] = stageGroups;
    expect(request.domain).toEqual(OPPORTUNITY_DOMAIN);
    expect(request.groupby).toEqual(["stage_id"]);
    expect(request.aggregates).toEqual([]);
    expect(request.context.read_group_expand).toBe(true);
    expect(request.context.default_type).toBe(PIPELINE_CONTEXT.default_type);
    expect(queryAllTexts(`${card("Lamps")} .o_crm_mobile_lead_stage option`)).toEqual(
        STAGES_IN_ORDER
    );
    expect(`${card("Lamps")} .o_crm_mobile_lead_stage`).toHaveValue(String(QUALIFIED));

    // Offline, a stage chosen on a card is saved on its record, which queues it.
    await setOffline(true);
    await contains(`${card("Lamps")} .o_crm_mobile_lead_stage`).select(String(NEW));
    const [save] = queued("crm.lead");
    expect(save.method).toBe("web_save");
    expect(save.args).toEqual([[5], { stage_id: NEW }]);
    expect(`${card("Lamps")} .o_crm_mobile_lead_stage`).toHaveValue(String(NEW));
    expect(`${card("Lamps")} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");
    expect(cardNames()).toHaveLength(7);
    expect(stageGroups).toHaveLength(1);
});

test.tags("mobile");
test("mobile pipeline offers the cached stages of an ungrouped list reopened offline", async () => {
    expect.errors(1);
    const propositionId = await addPropositionStage();
    const stageGroups = expandStageChoices();
    const setOffline = mockOffline();
    const options = `${card("Lamps")} .o_crm_mobile_lead_stage option`;
    await mountWithCleanup(WebClient);
    // Visited online: the server's stages, stored in the relational-field cache.
    await openAction(UNGROUPED_LEADS_ACTION_ID);
    await animationFrame();
    expect(stageGroups).toHaveLength(1);
    expect(queryAllTexts(options)).toEqual(STAGES_IN_ORDER);

    // Reopened offline: the cached stages, in the cache's (id) order, with no
    // request; a stage no lead has still moves a lead, queued.
    await setOffline(true);
    const calls = trackCalls();
    await openAction(UNGROUPED_LEADS_ACTION_ID);
    await animationFrame();
    expect(queryAllTexts(options)).toEqual(["New", "Qualified", "Won", "Proposition"]);
    expect(calls.filter((call) => call.endsWith("/formatted_read_group"))).toEqual([]);
    await contains(`${card("Lamps")} .o_crm_mobile_lead_stage`).select(String(propositionId));
    expect(queued("crm.lead").map(({ args }) => args)).toEqual([
        [[5], { stage_id: propositionId }],
    ]);
    expect(`${card("Lamps")} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");

    // Back online, the stages are read from the server again, in stage order.
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(stageGroups).toHaveLength(2);
    expect(queryAllTexts(options)).toEqual(STAGES_IN_ORDER);
    expect(`${card("Lamps")} .o_crm_mobile_lead_stage`).toHaveValue(String(propositionId));
    // The framework's cached root load of the offline opening; CRM code adds none.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_search_read"]);
});

test.tags("mobile");
test("mobile pipeline offers every cached stage of an ungrouped list reopened offline", async () => {
    expect.errors(1);
    await addPropositionStage();
    // Ten stages: more than the first page (8) of the relational-field cache's search.
    const extraNames = ["Stage 5", "Stage 6", "Stage 7", "Stage 8", "Stage 9", "Stage 10"];
    const extraIds = MockServer.env["crm.stage"].create(
        extraNames.map((name, index) => ({ name, sequence: index + 5 }))
    );
    const [ninthId, tenthId] = extraIds.slice(-2);
    const stageGroups = expandStageChoices();
    const setOffline = mockOffline();
    const lamps = `${card("Lamps")} .o_crm_mobile_lead_stage`;
    const office = `${card("Office Design")} .o_crm_mobile_lead_stage`;
    await mountWithCleanup(WebClient);
    // Visited online: the server's ten stages, stored in the relational-field cache.
    await openAction(UNGROUPED_LEADS_ACTION_ID);
    await animationFrame();
    expect(stageGroups).toHaveLength(1);
    expect(queryAllTexts(`${lamps} option`)).toEqual([...STAGES_IN_ORDER, ...extraNames]);

    // Reopened offline: every cached stage, in the cache's (id) order, with no
    // request; the ninth and tenth stages still move a lead, queued.
    await setOffline(true);
    const calls = trackCalls();
    await openAction(UNGROUPED_LEADS_ACTION_ID);
    await animationFrame();
    const cachedOrder = ["New", "Qualified", "Won", "Proposition", ...extraNames];
    expect(`${lamps} option`).toHaveCount(10);
    expect(queryAllTexts(`${lamps} option`)).toEqual(cachedOrder);
    expect(queryAllTexts(`${office} option`)).toEqual(cachedOrder);
    const stageRequest = (call) =>
        call.startsWith("crm.stage/") || call.endsWith("/formatted_read_group");
    expect(calls.filter(stageRequest)).toEqual([]);
    await contains(lamps).select(String(tenthId));
    await contains(office).select(String(ninthId));
    expect(
        queued("crm.lead")
            .map(({ method, args }) => [method, args])
            .sort(([, [[a]]], [, [[b]]]) => a - b)
    ).toEqual([
        ["web_save", [[1], { stage_id: ninthId }]],
        ["web_save", [[5], { stage_id: tenthId }]],
    ]);
    expect(lamps).toHaveValue(String(tenthId));
    expect(office).toHaveValue(String(ninthId));
    expect(`${card("Lamps")} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");
    expect(`${card("Office Design")} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");

    // Back online, both moves replay, and the stages are read from the server again.
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(serverStage(5)).toEqual([{ id: 5, stage_id: [tenthId, "Stage 10"] }]);
    expect(serverStage(1)).toEqual([{ id: 1, stage_id: [ninthId, "Stage 9"] }]);
    expect(stageGroups).toHaveLength(2);
    expect(queryAllTexts(`${lamps} option`)).toEqual([...STAGES_IN_ORDER, ...extraNames]);
    // The framework's cached root load of the offline opening; CRM code adds none.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_search_read"]);
});

test.tags("mobile");
test("mobile pipeline has no cached stage choice outside a secure context", async () => {
    // Outside a secure context the framework caches no relational value.
    mockNonSecureContext();
    let pipeline = null;
    patchWithCleanup(CrmMobilePipeline.prototype, {
        setup() {
            super.setup(...arguments);
            pipeline = this;
        },
    });
    await addPropositionStage();
    const stageGroups = expandStageChoices();
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    await animationFrame();
    // The server's stages are offered, but not cached: the cached stages, the
    // offline choices, are none, read with no error.
    expect(stageGroups).toHaveLength(1);
    expect(queryAllTexts(`${card("Lamps")} .o_crm_mobile_lead_stage option`)).toEqual(
        STAGES_IN_ORDER
    );
    expect(await pipeline.crmOffline.getCachedStages()).toEqual([]);
});

test.tags("mobile");
test("mobile pipeline offers its leads' stages on an ungrouped list reopened offline after another user cached a stage", async () => {
    expect.errors(1);
    let pipeline = null;
    patchWithCleanup(CrmMobilePipeline.prototype, {
        setup() {
            super.setup(...arguments);
            pipeline = this;
        },
    });
    await addPropositionStage();
    const stageGroups = expandStageChoices();
    const setOffline = mockOffline();
    const select = `${card("Lamps")} .o_crm_mobile_lead_stage`;
    await mountWithCleanup(WebClient);
    // Visited online: the server's stages, stored in the relational-field cache.
    await openAction(UNGROUPED_LEADS_ACTION_ID);
    await animationFrame();
    expect(stageGroups).toHaveLength(1);
    expect(queryAllTexts(`${select} option`)).toEqual(STAGES_IN_ORDER);
    // Another user of this browser cached a stage: the read of the cached stages fails.
    await writeOtherUserCacheRows("crm.stage", [{ id: 77, display_name: "Other stage" }]);
    await expectUndecryptableCache("crm.stage");

    // Reopened offline: no cached stage is usable, so the cards offer the stages of
    // the loaded leads, with no request and no error; a lead still moves, queued.
    await setOffline(true);
    await openAction(UNGROUPED_LEADS_ACTION_ID);
    await animationFrame();
    expect(await pipeline.crmOffline.getCachedStages()).toEqual([]);
    expect(queryAllTexts(`${select} option`)).toEqual(["New", "Qualified", "Won"]);
    expect(stageGroups).toHaveLength(1);
    expect(".o_error_dialog").toHaveCount(0);
    await contains(select).select(String(NEW));
    expect(queued("crm.lead").map(({ args }) => args)).toEqual([[[5], { stage_id: NEW }]]);
    // The framework's cached root load of the offline opening; CRM code adds none.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_search_read"]);
});

test.tags("mobile");
test("mobile pipeline reads the stage choices once per ungrouped search, the last one only", async () => {
    let controller = null;
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    await addPropositionStage();
    const stageGroups = expandStageChoices();
    // Stage-choice answers to hold, in request order.
    const held = [];
    onRpc("crm.lead", "formatted_read_group", async () => {
        await held.shift()?.promise;
    });
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    await animationFrame();
    const options = `${card("Lamps")} .o_crm_mobile_lead_stage option`;
    expect(stageGroups).toHaveLength(1);
    expect(queryAllTexts(options)).toEqual(STAGES_IN_ORDER);

    // A root reload of the same search reads no stage again.
    await controller.model.load();
    await animationFrame();
    expect(stageGroups).toHaveLength(1);

    // A first search's answer is held while a second search is answered: the
    // first answer, sent last with a renamed stage, changes nothing.
    const firstAnswer = Promise.withResolvers();
    held.push(firstAnswer);
    controller.env.searchModel.splitAndAddDomain(`[("id", "!=", 0)]`);
    await animationFrame();
    controller.env.searchModel.splitAndAddDomain(`[("id", "!=", 999)]`);
    await animationFrame();
    expect(stageGroups).toHaveLength(2);
    expect(stageGroups[1].domain).toEqual(["&", ["id", "!=", 0], ["id", "!=", 999]]);
    expect(queryAllTexts(options)).toEqual(STAGES_IN_ORDER);
    MockServer.env["crm.stage"].write([QUALIFIED], { name: "Renamed" });
    firstAnswer.resolve();
    await animationFrame();
    expect(stageGroups).toHaveLength(3);
    expect(stageGroups[2].domain).toEqual([["id", "!=", 0]]);
    expect(queryAllTexts(options)).toEqual(STAGES_IN_ORDER);
});

test.tags("mobile");
test("mobile pipeline keeps the server's stage choices of an ungrouped list offline, and reads them again online", async () => {
    expect.errors(1);
    let controller = null;
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    await addPropositionStage();
    const stageGroups = expandStageChoices();
    const setOffline = mockOffline();
    const drops = dropConnections();
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    await animationFrame();
    const options = `${card("Lamps")} .o_crm_mobile_lead_stage option`;
    controller.env.searchModel.splitAndAddDomain(`[("id", "!=", 0)]`);
    await animationFrame();
    expect(stageGroups.map(({ domain }) => domain)).toEqual([[], [["id", "!=", 0]]]);

    // Offline, back to the first search (served from the cache): no request, and
    // the server's stages stay, in stage order, rather than the cached ones.
    await setOffline(true);
    const calls = trackCalls();
    controller.env.searchModel.clearQuery();
    await animationFrame();
    expect(cardNames()).toHaveLength(7);
    expect(queryAllTexts(options)).toEqual(STAGES_IN_ORDER);
    expect(calls.filter((call) => call.endsWith("/formatted_read_group"))).toEqual([]);
    expect(stageGroups).toHaveLength(2);

    // Back online, the stages of that search are read from the server.
    await setOffline(false);
    await animationFrame();
    expect(stageGroups.map(({ domain }) => domain).at(-1)).toEqual([]);
    expect(stageGroups).toHaveLength(3);

    // The connection drops during the read of a new search: the server's stages
    // stay, and are read again once the connection is back.
    drops.add("crm.lead/formatted_read_group");
    controller.env.searchModel.splitAndAddDomain(`[("id", "!=", 0)]`);
    await animationFrame();
    expect(drops.size).toBe(0);
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    expect(queryAllTexts(options)).toEqual(STAGES_IN_ORDER);
    await setOffline(false);
    await animationFrame();
    expect(stageGroups.map(({ domain }) => domain).slice(3)).toEqual([[["id", "!=", 0]]]);
    expect(queryAllTexts(options)).toEqual(STAGES_IN_ORDER);
    // The framework's cached root load of the offline search; CRM code adds none.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_search_read"]);
});

/**
 * Holds until released: the activity-type warm-up, the first `crm.lead`
 * `formatted_read_group` (then answered as a lost connection, a 502 as the
 * offline mock answers), and every read of the cached stages
 * (`getCachedStages()`). The counts grow as they arrive.
 */
function holdStageChoiceReads() {
    const held = {
        warmUps: 0,
        lostReads: 0,
        cachedReads: 0,
        warmUp: Promise.withResolvers(),
        lostRead: Promise.withResolvers(),
        cachedRead: Promise.withResolvers(),
    };
    onRpc("mail.activity.type", "web_search_read", async () => {
        held.warmUps++;
        await held.warmUp.promise;
    });
    onRpc("/*", async (request) => {
        const { pathname } = new URL(request.url);
        if (!held.lostReads && pathname.endsWith("/crm.lead/formatted_read_group")) {
            held.lostReads++;
            await held.lostRead.promise;
            return new Response("", { status: 502 });
        }
    });
    patchWithCleanup(IndexedDB.prototype, {
        async getAllKeys(table) {
            if (table === `${OfflinePlugin.MANY2X_TABLE_PREFIX}crm.stage`) {
                held.cachedReads++;
                await held.cachedRead.promise;
            }
            return super.getAllKeys(...arguments);
        },
    });
    return held;
}

test.tags("mobile");
test("mobile pipeline reads the stage choices again when the connection returns during their cached read", async () => {
    await addPropositionStage();
    const stageGroups = expandStageChoices();
    const held = holdStageChoiceReads();
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    await animationFrame();
    const plugin = getService(OfflinePlugin);
    const options = `${card("Lamps")} .o_crm_mobile_lead_stage option`;
    expect(held.warmUps).toBe(1);
    expect(held.lostReads).toBe(1);
    expect(plugin.isOffline()).toBe(false);
    expect(queryAllTexts(options)).toEqual(["New", "Qualified", "Won"]);

    // The lost connection turns the framework offline, and the load waits for the
    // cached stages: the cards offer their leads' stages meanwhile.
    held.lostRead.resolve();
    await animationFrame();
    expect(plugin.isOffline()).toBe(true);
    expect(held.cachedReads).toBe(1);
    expect(stageGroups).toEqual([]);
    expect(queryAllTexts(options)).toEqual(["New", "Qualified", "Won"]);

    // The warm-up succeeds while that load still runs: the framework is back
    // online before the load knows that it read no stage from the server.
    held.warmUp.resolve();
    await animationFrame();
    expect(plugin.isOffline()).toBe(false);
    expect(stageGroups).toEqual([]);

    // Once the cached read ends, the stages are read from the server again, and
    // every stage is offered, in stage order.
    held.cachedRead.resolve();
    await animationFrame();
    expect(stageGroups.map(({ context }) => context.read_group_expand)).toEqual([true]);
    expect(held.cachedReads).toBe(1);
    expect(queryAllTexts(options)).toEqual(STAGES_IN_ORDER);
});

test.tags("mobile");
test("mobile pipeline left during the cached read of its stage choices reads them no more", async () => {
    await addPropositionStage();
    const stageGroups = expandStageChoices();
    const held = holdStageChoiceReads();
    await mountWithCleanup(WebClient);
    await openAction(UNGROUPED_LEADS_ACTION_ID);
    await animationFrame();
    expect(held.lostReads).toBe(1);
    held.lostRead.resolve();
    await animationFrame();
    expect(held.cachedReads).toBe(1);
    held.warmUp.resolve();
    await animationFrame();
    expect(getService(OfflinePlugin).isOffline()).toBe(false);

    // The ungrouped list is left for the stage pipeline before its cached read
    // ends: the destroyed pipeline then starts no load, and reports no error.
    await openAction(ACTION_ID);
    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    held.cachedRead.resolve();
    await animationFrame();
    expect(stageGroups).toEqual([]);
});

test.tags("mobile");
test("mobile pipeline reports a server error of the stage choices once, offering its leads' stages", async () => {
    expect.errors(1);
    let requests = 0;
    onRpc("crm.lead", "formatted_read_group", () => {
        requests++;
        throw makeServerError({ message: "Stages unavailable" });
    });
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    await animationFrame();
    const select = `${card("Lamps")} .o_crm_mobile_lead_stage`;
    expect(queryAllTexts(`${select} option`)).toEqual(["New", "Qualified", "Won"]);

    // Later renders of the same search do not ask again, and a lead still moves.
    await contains(select).select(String(NEW));
    await animationFrame();
    expect(select).toHaveValue(String(NEW));
    expect(MockServer.env["crm.lead"].search_read([["id", "=", 5]], ["stage_id"])).toEqual([
        { id: 5, stage_id: [NEW, "New"] },
    ]);
    expect(requests).toBe(1);
    expect.verifyErrors(["Stages unavailable"]);
});

test.tags("mobile");
test("mobile stage pipeline reads no stage choices", async () => {
    const stageGroups = expandStageChoices();
    await mountPipeline();
    await animationFrame();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    expect(queryAllTexts(`${card("Lamps")} .o_crm_mobile_lead_stage option`)).toEqual([
        "New",
        "Qualified",
        "Won",
    ]);
    expect(stageGroups).toEqual([]);
});

test.tags("mobile");
test("mobile pipeline adds activities to an arch without them, after sync in the desktop fallback", async () => {
    expect.errors(1);
    const setOffline = mockOffline();
    const specs = rootSpecs();
    // Visited online at desktop size: the arch's own variant, without activities.
    await resize({ width: 1366, height: 768 });
    await mountPipeline({ arch: plainPipelineArch });
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(specs).toHaveLength(1);
    expect("activity_ids" in specs[0].specification).toBe(false);

    // Offline on a phone, the desktop variant is served from the cache: the activity
    // sheet has no activity data until the next sync.
    await setOffline(true);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    await openActivities("Office Design");
    expect(".o_crm_mobile_activity_row").toHaveCount(0);
    expect(".o_crm_mobile_activities_notice").toHaveText("Activities load after sync");
    expect(".o_crm_mobile_activities_notice").toHaveAttribute("role", "status");
    await closeSheet();

    // Reconnected, the root reloads with the mobile variant, which adds the activity
    // rows and the stage revenue the arch lacks.
    await reconnect(setOffline);
    const reload = specs.at(-1);
    expect(reload.method).toBe("web_read_group");
    expect(Object.keys(reload.specification.activity_ids.fields)).toEqual(ACTIVITY_SUBFIELDS);
    expect(reload.aggregates).toInclude("expected_revenue:sum");
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);
    // Only the framework's offline root load of the never-cached mobile variant.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

test.tags("mobile");
test("mobile pipeline reconnected on a wide screen reloads the root of the desktop fallback", async () => {
    expect.errors(2);
    const setOffline = mockOffline();
    const specs = rootSpecs();
    const rootLoads = () => specs.filter(({ method }) => method === "web_read_group");
    const progressBars = () =>
        queryAll(".o_kanban_group .o_column_progress .progress-bar").map((bar) =>
            bar.getAttribute("aria-valuenow")
        );
    const columnSums = () => queryAllTexts(".o_kanban_group .o_kanban_counter .o_animated_number");
    // Visited online at desktop size: the desktop variant is cached, and the columns
    // show their progress bars and revenue sums.
    await resize({ width: 1366, height: 768 });
    await mountPipeline();
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(rootLoads()).toHaveLength(1);
    const [desktopLoad] = rootLoads();
    const onlineBars = progressBars();
    const onlineSums = columnSums();
    expect(onlineBars.some((count) => count !== "0")).toBe(true);
    expect(onlineSums.length).toBeGreaterThan(0);

    // Offline on a phone, the never-cached mobile variant falls back to the cached
    // desktop one.
    await setOffline(true);
    const calls = trackCalls();
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);

    // Widened while still offline: the desktop kanban, from the cache, whose progress
    // bars cannot load offline.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(progressBars()).toEqual([]);
    expect(columnSums()).toEqual([]);

    // Reconnected on the wide screen: the fallback ends with one root load online,
    // the request of the first desktop load, and the columns show their progress
    // bars and sums again.
    calls.splice(0);
    const loadCount = rootLoads().length;
    await reconnect(setOffline);
    expect(rootLoads()).toHaveLength(loadCount + 1);
    expect(rootLoads().at(-1)).toEqual(desktopLoad);
    expect(calls.filter((call) => call === "crm.lead/web_read_group")).toHaveLength(1);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(progressBars()).toEqual(onlineBars);
    expect(columnSums()).toEqual(onlineSums);

    // Back on a phone, online: one root load, with the mobile variant.
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(rootLoads()).toHaveLength(loadCount + 2);
    const mobileLoad = rootLoads().at(-1);
    expect(Object.keys(mobileLoad.specification.activity_ids.fields)).toEqual(ACTIVITY_SUBFIELDS);
    expect(mobileLoad.aggregates).toInclude("expected_revenue:sum");
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    // Only the framework's cached root loads of the desktop variant, served offline
    // on the phone and after the widening.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile pipeline reconnected on a wide screen reloads the desktop fallback after its replay", async () => {
    expect.errors(2);
    const setOffline = mockOffline();
    const arrivals = [];
    onRpc("crm.lead", "web_read_group", () => {
        arrivals.push("web_read_group");
    });
    onRpc("crm.lead", "web_save", ({ args }) => {
        arrivals.push(`web_save ${JSON.stringify(args)}`);
    });
    const desktopCard = (stage, name) =>
        `.o_kanban_group:has(.o_column_title:contains(${stage})) .o_kanban_record:contains(${name})`;
    // Visited online at desktop size only.
    await resize({ width: 1366, height: 768 });
    await mountPipeline();
    expect(desktopCard("New", "Office Design")).toHaveCount(1);

    // Offline on a phone, the desktop fallback's card moves a lead to another stage.
    await setOffline(true);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    await contains(`${card("Office Design")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    expect(queued("crm.lead").map(({ method, args }) => [method, args])).toEqual([
        ["web_save", [[1], { stage_id: QUALIFIED }]],
    ]);

    // Widened while still offline: the desktop kanban, from the cache.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(0);

    // Reconnected on the wide screen: the root reloads once, after the replayed move,
    // so the kanban shows the lead where the server now has it.
    arrivals.splice(0);
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(arrivals).toEqual([`web_save [[1],{"stage_id":${QUALIFIED}}]`, "web_read_group"]);
    expect(MockServer.env["crm.lead"].search_read([["id", "=", 1]], ["stage_id"])).toEqual([
        { id: 1, stage_id: [QUALIFIED, "Qualified"] },
    ]);
    expect(desktopCard("Qualified", "Office Design")).toHaveCount(1);
    expect(desktopCard("New", "Office Design")).toHaveCount(0);
    expect(".o_kanban_group .o_column_progress .progress-bar").not.toHaveCount(0);
    // Only the framework's cached root loads of the desktop variant, served offline
    // on the phone and after the widening.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile pipeline cards follow a lead marked won and a lead deleted offline", async () => {
    expect.errors(4);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(BUTTONS_ACTION_ID);
    await visitLead("Office Design");
    await visitLead("Quote for Chairs");
    await setOffline(true);

    // "Won" is available offline; the phone's "More" menu, which holds "Lost" (a
    // wizard), is disabled.
    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();
    expect(".o_statusbar_buttons button[name=action_set_won_rainbowman]").toBeEnabled();
    expect(".o_statusbar_buttons button[title=More]").not.toBeEnabled();
    await contains(".o_statusbar_buttons button[name=action_set_won_rainbowman]").click();
    const [won] = queued("crm.lead");
    expect(won.method).toBe("action_set_won");
    expect(won.args).toEqual([[1]]);
    // Back in the pipeline, the card stays in its stage until the replay, pending.
    await contains(".o_back_button").click();
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(`${card("Office Design")} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");

    // Deleted from its form: the form is left and the card hidden at once.
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_open`).click();
    await contains(".o_cp_action_menus .dropdown-toggle").click();
    await contains(".o-dropdown--menu .dropdown-item:contains(Delete)").click();
    await contains(".modal-footer .btn-danger:contains(Delete)").click();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(cardNames()).toEqual(["Office Design", "Desk Upgrade"]);
    expect(headerTexts()[1]).toBe("2");
    expect(queued("crm.lead").map(({ method, args }) => [method, args[0]])).toEqual([
        ["action_set_won", [1]],
        ["unlink", [2]],
    ]);

    // Replayed: the lead is won, in the won stage, and the other one is deleted.
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].search_count([["id", "=", 2]])).toBe(0);
    expect(headerTexts()).toEqual(["New", "1", "$ 300"]);
    expect(cardNames()).toEqual(["Desk Upgrade"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Won");
    expect(cardNames().sort()).toEqual(["Office Design", "Signed Deal"]);
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile pipeline ignores malformed queued lead writes", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    // Offline only once the messaging store's first fetch is answered: the network
    // would otherwise fail it.
    await getService("mail.store").isReadyPromise;
    await setOffline(true);
    // The framework queue keeps the entries as scheduled (and reads them back so).
    const plugin = getService(OfflinePlugin);
    const scheduleSave = (args, changes) =>
        plugin.scheduleORM(
            "crm.lead",
            "web_save",
            args,
            { context: PIPELINE_CONTEXT, specification: {} },
            { extras: { timeStamp: Date.now(), changes } }
        );

    // Saves of a loaded lead whose display values are not a field-value mapping (an
    // array, even one carrying field-named properties): no error, and the card and
    // the header keep the lead's values, the card showing its pending writes.
    scheduleSave([[1], {}], "bad");
    scheduleSave([[1], {}], 42);
    scheduleSave([[1], {}], Object.assign(["Bogus"], { name: "Array Lead", expected_revenue: 9 }));
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(textOf(`${card("Office Design")} .o_crm_mobile_lead_partner`)).toBe("Azure Interior");
    expect(textOf(`${card("Office Design")} .o_crm_mobile_lead_revenue`)).toBe("$ 100.00");
    expect(`${card("Office Design")} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");

    // Saves whose target ids are not an empty array create nothing: no provisional
    // card, and the count and revenue are unchanged.
    for (const ids of [99999, {}, null]) {
        scheduleSave([ids, { stage_id: NEW, name: "Bogus Lead", expected_revenue: 10 }], {
            name: "Bogus Lead",
            stage_id: { id: NEW, display_name: "New" },
            expected_revenue: 10,
        });
    }
    await animationFrame();
    expect(".o_crm_mobile_lead_card_provisional").toHaveCount(0);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);

    // A create whose display values are not a mapping: its provisional card shows
    // the values it creates.
    const vals = { stage_id: NEW, name: "Valid Lead", contact_name: "Val Contact" };
    scheduleSave([[], { ...vals, expected_revenue: 25 }], "bad");
    await animationFrame();
    expect(".o_crm_mobile_lead_card_provisional").toHaveCount(1);
    expect(cardNames()).toEqual([
        "Office Design",
        "Quote for Chairs",
        "Desk Upgrade",
        "Valid Lead",
    ]);
    expect(textOf(`${card("Valid Lead")} .o_crm_mobile_lead_partner`)).toBe("Val Contact");
    expect(`${card("Valid Lead")} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");
    expect(headerTexts()).toEqual(["New", "4", "$ 625"]);

    // Saves of a loaded lead whose values are not a field-value mapping: a stage
    // choice on its card, which reads the lead's queued saves back to order its own
    // write, still moves it without error.
    scheduleSave([[1], 42], {});
    scheduleSave([[1], "bad"], {});
    await animationFrame();
    await contains(`${card("Office Design")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    expect(cardNames()).toEqual(["Quote for Chairs", "Desk Upgrade", "Valid Lead"]);
    expect(headerTexts()).toEqual(["New", "3", "$ 525"]);

    // Nothing is discarded: every entry stays queued for the framework to replay.
    expect(queued("crm.lead")).toHaveLength(10);
});

test.tags("mobile");
test("mobile pipeline reads the queue once per loaded lead and once for pending creates per render", async () => {
    // What each render of the pipeline (until its patch) reads from the queue through
    // its own hook: the leads it projects, and the stages of the pending creates;
    // and how many times it builds the stage choices of its cards.
    const newRender = () => ({ projected: [], pendingCreates: [], stageChoices: 0 });
    const renders = [];
    let render = newRender();
    patchWithCleanup(CrmMobilePipeline.prototype, {
        get stages() {
            render.stageChoices++;
            return super.stages;
        },
        setup() {
            super.setup(...arguments);
            const { projectLead, pendingCreates } = this.crmOffline;
            this.crmOffline.projectLead = (record) => {
                render.projected.push(record.resId);
                return projectLead(record);
            };
            this.crmOffline.pendingCreates = (stageId) => {
                render.pendingCreates.push(stageId);
                return pendingCreates(stageId);
            };
            onWillPatch(() => {
                render.projected.sort((a, b) => a - b);
                renders.push(render);
                render = newRender();
            });
        },
    });
    // The live (not destroyed) lead cards, whose stage choices are compared.
    const cards = new Set();
    patchWithCleanup(CrmMobileLeadCard.prototype, {
        setup() {
            super.setup(...arguments);
            cards.add(this);
            onWillDestroy(() => cards.delete(this));
        },
    });
    const setOffline = mockOffline();
    await mountPipeline();
    // Both stages visited online.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();

    // Offline, a loaded lead moved to the next stage and a lead created.
    await setOffline(true);
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    expect(queued("crm.lead").map(({ method, args }) => [method, args[0]])).toEqual([
        ["web_save", [3]],
        ["web_save", []],
    ]);
    expect(headerTexts()).toEqual(["New", "3", "$ 350"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Offline Lead"]);

    // One render per stage switch. The header and the cards share one projection
    // of each loaded lead (both unfolded stages) and one read of the displayed
    // stage's pending creates; the stage choices are built once for all its cards.
    renders.splice(0);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 1,000"]);
    expect(cardNames()).toEqual(["Desk Upgrade", "Conference Room", "Lamps", "Storage Racks"]);
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(headerTexts()).toEqual(["New", "3", "$ 350"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Offline Lead"]);
    expect(renders).toEqual([
        { projected: [1, 2, 3, 4, 5, 6], pendingCreates: [QUALIFIED], stageChoices: 1 },
        { projected: [1, 2, 3, 4, 5, 6], pendingCreates: [NEW], stageChoices: 1 },
    ]);
    // Every card of the stage, the provisional one included, holds the same choices.
    const stageLists = new Set([...cards].map((leadCard) => leadCard.props.stages));
    expect(cards.size).toBe(3);
    expect(stageLists.size).toBe(1);
    expect([...stageLists][0].map(({ display_name }) => display_name)).toEqual([
        "New",
        "Qualified",
        "Won",
    ]);
});

// -----------------------------------------------------------------------------
// Lead card (CrmMobileLeadCard)
// -----------------------------------------------------------------------------

/** Minimum width and height, in px, of every touch target of the mobile lead card. */
const TOUCH_TARGET = 44;

test.tags("mobile");
test("mobile lead card shows name, partner, revenue and 44px targets", async () => {
    await mountPipeline();
    expect(".o_crm_mobile_lead_card").toHaveCount(3);
    expect(textOf(`${card("Office Design")} .o_crm_mobile_lead_partner`)).toBe("Azure Interior");
    expect(textOf(`${card("Office Design")} .o_crm_mobile_lead_revenue`)).toBe("$ 100.00");
    // Without a partner, the contact name is shown.
    expect(textOf(`${card("Quote for Chairs")} .o_crm_mobile_lead_partner`)).toBe("Bob Contact");
    expect(textOf(`${card("Quote for Chairs")} .o_crm_mobile_lead_revenue`)).toBe("$ 200.00");
    expect(textOf(`${card("Desk Upgrade")} .o_crm_mobile_lead_partner`)).toBe("Deco Addict");
    expect(queryAllTexts(`${card("Office Design")} .o_crm_mobile_lead_stage option`)).toEqual([
        "New",
        "Qualified",
        "Won",
    ]);
    expect(`${card("Office Design")} .o_crm_mobile_lead_stage`).toHaveValue(String(NEW));
    expect(".o_crm_mobile_lead_card .o_crm_mobile_pending_sync").toHaveCount(0);

    // Open, stage and activities controls of each card: at least 44 x 44 px.
    const targets = queryAll(".o_crm_mobile_lead_card :is(a, button, input, select, textarea)");
    expect(targets).toHaveLength(9);
    for (const target of targets) {
        const { width, height } = target.getBoundingClientRect();
        expect(width >= TOUCH_TARGET && height >= TOUCH_TARGET).toBe(true, {
            message: `${target.className}: ${width} x ${height}`,
        });
    }
});

test.tags("mobile");
test("mobile lead card pending-sync indicator reads the queue", async () => {
    expect.errors(7);
    // The server rejects the replayed edit of "Desk Upgrade" only.
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (args[0]?.[0] === 3) {
            throw makeServerError({ message: "Stage is locked" });
        }
    });
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await visitLead("Office Design");
    await visitLead("Desk Upgrade");

    /** Edits the expected revenue of a lead in its form, saves, and goes back. */
    const editRevenue = async (name, revenue) => {
        await contains(`${card(name)} .o_crm_mobile_lead_open`).click();
        await contains(".o_field_widget[name=expected_revenue] input").edit(String(revenue));
        await contains(".o_form_button_save").click();
        await contains(".o_back_button").click();
    };
    const badge = (name) => textOf(`${card(name)} .o_crm_mobile_pending_sync`);

    // An offline edit in the lead form (another Record instance than the card's).
    await setOffline(true);
    await editRevenue("Office Design", 150);
    expect(badge("Office Design")).toBe("Pending sync");
    expect(textOf(`${card("Office Design")} .o_crm_mobile_lead_revenue`)).toBe("$ 150.00");
    expect(badge("Quote for Chairs")).toBe(null);
    expect(queued("crm.lead").map(({ method, args }) => ({ method, ids: args[0] }))).toEqual([
        { method: "web_save", ids: [1] },
    ]);

    // Gone after a successful replay.
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(badge("Office Design")).toBe(null);
    expect(MockServer.env["crm.lead"].search_read([["id", "=", 1]], ["expected_revenue"])).toEqual([
        { id: 1, expected_revenue: 150 },
    ]);

    // Gone after a discard in the offline systray.
    await setOffline(true);
    await editRevenue("Office Design", 175);
    expect(badge("Office Design")).toBe("Pending sync");
    await contains("div.o_nav_entry.o_offline_systray").click();
    await contains(".o-dropdown--menu button[title='Discard offline changes']").click();
    await contains(".modal-dialog .modal-footer button.btn-primary").click();
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(badge("Office Design")).toBe(null);
    expect(textOf(`${card("Office Design")} .o_crm_mobile_lead_revenue`)).toBe("$ 150.00");

    // "Sync failed" once the replay is rejected (parked).
    await editRevenue("Desk Upgrade", 333);
    expect(badge("Desk Upgrade")).toBe("Pending sync");
    await reconnect(setOffline);
    expect(badge("Desk Upgrade")).toBe("Sync failed");
    expect(`${card("Desk Upgrade")} .o_crm_mobile_pending_sync`).toHaveClass("text-bg-danger");
    const [parked] = queued("crm.lead");
    expect(parked.args[0]).toEqual([3]);
    expect(parked.extras.error).toInclude("Stage is locked");
    expect(badge("Office Design")).toBe(null);
    // The framework's own cached loads offline: each form opening, each return to
    // the pipeline, and the pipeline reload that follows the discard.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile lead card announces its sync state through a status region", async () => {
    // The server rejects the replayed stage change of "Lamps" only.
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (args[0]?.[0] === 5) {
            throw makeServerError({ message: "Stage is locked" });
        }
    });
    const setOffline = mockOffline();
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    const status = (name) => `${card(name)} .o_crm_mobile_lead_sync_status`;
    const badge = (name) => `${card(name)} .o_crm_mobile_pending_sync`;

    // Every card holds one visually hidden status region, present and empty while
    // nothing is queued, so that a later change of its text is announced.
    expect(".o_crm_mobile_lead_card").toHaveCount(7);
    expect(
        ".o_crm_mobile_lead_card .o_crm_mobile_lead_sync_status.visually-hidden[role=status]"
    ).toHaveCount(7);
    expect(queryAllTexts(".o_crm_mobile_lead_sync_status")).toEqual(Array(7).fill(""));
    expect(".o_crm_mobile_lead_card .o_crm_mobile_pending_sync").toHaveCount(0);
    // Out of the card's flex flow, the region adds no gap between its rows.
    expect(status("Storage Racks")).toHaveStyle({ position: "absolute" });
    const rowGap = parseFloat(getComputedStyle(queryFirst(card("Storage Racks"))).rowGap);
    const openEl = queryFirst(`${card("Storage Racks")} .o_crm_mobile_lead_open`);
    const actionsEl = queryFirst(`${card("Storage Racks")} .o_crm_mobile_lead_actions`);
    expect(
        Math.round(actionsEl.getBoundingClientRect().top - openEl.getBoundingClientRect().bottom)
    ).toBe(Math.round(rowGap));

    // An offline stage change of a displayed card: the region reads "Pending sync"
    // and the lead name at once, like the visible badge (without the name), which
    // assistive technology skips so that it is not read twice.
    await advanceTime(CRM_SYNC_STATUS_DELAY);
    await setOffline(true);
    await contains(`${card("Lamps")} .o_crm_mobile_lead_stage`).select(String(NEW));
    expect(status("Lamps")).toHaveText("Pending sync: Lamps");
    expect(badge("Lamps")).toHaveText("Pending sync");
    expect(badge("Lamps")).toHaveAttribute("aria-hidden", "true");
    expect(status("Storage Racks")).toHaveText("");

    // Rejected on replay, the write is parked: the region reads "Sync failed".
    await reconnect(setOffline);
    const [parked] = queued("crm.lead");
    expect(parked.args[0]).toEqual([5]);
    expect(parked.extras.error).toInclude("Stage is locked");
    expect(status("Lamps")).toHaveText("Sync failed: Lamps");
    expect(badge("Lamps")).toHaveText("Sync failed");
    expect(badge("Lamps")).toHaveAttribute("aria-hidden", "true");
    expect(".o_crm_mobile_lead_card .o_crm_mobile_lead_sync_status[role=status]").toHaveCount(7);
    expect(status("Storage Racks")).toHaveText("");
    // The ungrouped list announces the outcome of the replay as the stage pipeline does.
    expect(
        ".o_crm_mobile_pipeline_ungrouped > .o_crm_mobile_pipeline_sync_status[role=status]"
    ).toHaveText("Some offline changes failed to sync");
});

test.tags("mobile");
test("mobile lead card and activity sheet controls are named after their lead and activity", async () => {
    await makeMockServer();
    // "Desk Upgrade" without a name; on "Conference Room", an activity shown under its
    // type only and one with neither a summary nor a type.
    MockServer.env["crm.lead"].write([3], { name: false });
    MockServer.env["mail.activity"].write([3], { summary: false });
    const [untitledId] = MockServer.env["mail.activity"].create([
        {
            res_model: "crm.lead",
            res_id: 4,
            activity_type_id: false,
            summary: false,
            date_deadline: "2026-10-12",
            user_id: serverState.userId,
            state: "planned",
        },
    ]);
    const setOffline = mockOffline();
    await mountPipeline();
    const ariaLabels = (selector) => queryAll(selector).map((el) => el.getAttribute("aria-label"));

    // Each card names its stage selector and icon-only activities button after its
    // lead, the button keeping its "Activities" tooltip; a lead without a name gets
    // the plain labels.
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", ""]);
    expect(ariaLabels(".o_crm_mobile_lead_card .o_crm_mobile_lead_stage")).toEqual([
        "Stage of Office Design",
        "Stage of Quote for Chairs",
        "Stage",
    ]);
    expect(ariaLabels(".o_crm_mobile_lead_card .o_crm_mobile_lead_activities_button")).toEqual([
        "Activities: Office Design",
        "Activities: Quote for Chairs",
        "Activities",
    ]);
    expect(".o_crm_mobile_lead_activities_button[title=Activities]").toHaveCount(3);
    // The open buttons are named after their lead alone (their partner and revenue
    // describe them); a lead without a name keeps the name its content gives.
    expect(ariaLabels(".o_crm_mobile_lead_card .o_crm_mobile_lead_open")).toEqual([
        "Office Design",
        "Quote for Chairs",
        null,
    ]);

    // The sheet of a lead with two activities: each "Mark done" is named after the
    // title of its row and keeps its visible text.
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);
    expect(ariaLabels(".o_crm_mobile_activity_done")).toEqual([
        "Mark done: Follow-up call",
        "Mark done: Send brochure",
    ]);
    expect(queryAllTexts(".o_crm_mobile_activity_done")).toEqual(["Mark done", "Mark done"]);
    await closeSheet();

    // A row without a summary is named after the type it shows; a row with neither
    // gets the plain label.
    await contains(".o_crm_mobile_pipeline_next").click();
    await openActivities("Conference Room");
    expect(`${activityRow(3)} .o_crm_mobile_activity_title`).toHaveText("Email");
    expect(`${activityRow(3)} .o_crm_mobile_activity_done`).toHaveAttribute(
        "aria-label",
        "Mark done: Email"
    );
    expect(`${activityRow(untitledId)} .o_crm_mobile_activity_title`).toHaveText("");
    expect(`${activityRow(untitledId)} .o_crm_mobile_activity_done`).toHaveAttribute(
        "aria-label",
        "Mark done"
    );
    expect(queryAllTexts(".o_crm_mobile_activity_done")).toEqual(["Mark done", "Mark done"]);
    await closeSheet();

    // Marked done offline: the name follows the visible "Done · Pending sync" label.
    await contains(".o_crm_mobile_pipeline_prev").click();
    await setOffline(true);
    await openActivities("Office Design");
    await contains(`${activityRow(1)} .o_crm_mobile_activity_done`).click();
    expect(`${activityRow(1)} .o_crm_mobile_activity_done`).toHaveText("Done · Pending sync");
    expect(`${activityRow(1)} .o_crm_mobile_activity_done`).toHaveAttribute(
        "aria-label",
        "Done · Pending sync: Follow-up call"
    );
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).toHaveAttribute(
        "aria-label",
        "Mark done: Send brochure"
    );
    expect(queued("mail.activity").map(({ method, args }) => [method, args[0]])).toEqual([
        ["action_done", [1]],
    ]);
});

/**
 * Texts of the elements that the `aria-describedby` of the first element matching
 * `selector` references, in order (`[]` without the attribute). Each one is a
 * visually hidden element of the same lead card, which assistive technology reads
 * only through that reference.
 *
 * @param {string} selector
 * @returns {string[]}
 */
function describedBy(selector) {
    const control = queryFirst(selector);
    const ids = control.getAttribute("aria-describedby")?.split(" ") || [];
    return ids.map((id) => {
        const description = queryFirst(`#${id}`);
        expect(control.closest(".o_crm_mobile_lead_card").contains(description)).toBe(true);
        expect(description).toHaveClass("visually-hidden");
        expect(description).toHaveAttribute("aria-hidden", "true");
        return description.textContent.replace(/\u00a0/g, " ");
    });
}

test.tags("mobile");
test("mobile lead card status region is inserted empty and reads out the state once displayed", async () => {
    expect.errors(2);
    // Name of each card inserted, with the text of its status region at insertion.
    const inserted = [];
    patchWithCleanup(CrmMobileLeadCard.prototype, {
        setup() {
            super.setup(...arguments);
            onMounted(() => {
                const { name } = this.values;
                inserted.push([name, textOf(`${card(name)} .o_crm_mobile_lead_sync_status`)]);
            });
        },
    });
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await visitLead("Office Design");
    const status = (name) => `${card(name)} .o_crm_mobile_lead_sync_status`;

    // A lead created offline: its provisional card is inserted with an empty region,
    // which then reads "Pending sync" and the lead name, as no text is announced
    // that the region is inserted with.
    await setOffline(true);
    inserted.splice(0);
    await quickCreateLead({ name: "Offline Lead", revenue: 10 });
    expect(inserted).toEqual([["Offline Lead", ""]]);
    expect(`${card("Offline Lead")} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");
    await advanceTime(CRM_SYNC_STATUS_DELAY);
    expect(status("Offline Lead")).toHaveText("Pending sync: Offline Lead");
    expect(status("Office Design")).toHaveText("");

    // A lead edited offline in its form: back on the pipeline, mounted again, every
    // card is inserted with an empty region; the pending ones then read their state.
    inserted.splice(0);
    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();
    await contains(".o_field_widget[name=expected_revenue] input").edit("150");
    await contains(".o_form_button_save").click();
    await contains(".o_back_button").click();
    expect(inserted.sort()).toEqual([
        ["Desk Upgrade", ""],
        ["Office Design", ""],
        ["Offline Lead", ""],
        ["Quote for Chairs", ""],
    ]);
    expect(`${card("Office Design")} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");
    await advanceTime(CRM_SYNC_STATUS_DELAY);
    expect(status("Office Design")).toHaveText("Pending sync: Office Design");
    expect(status("Offline Lead")).toHaveText("Pending sync: Offline Lead");
    expect(status("Quote for Chairs")).toHaveText("");
    expect(status("Desk Upgrade")).toHaveText("");
    // The framework's own cached loads offline: the form opening and the return to
    // the pipeline.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

/** The visually hidden status region of the mobile pipeline, for replay outcomes. */
const PIPELINE_SYNC_STATUS = ".o_crm_mobile_pipeline > .o_crm_mobile_pipeline_sync_status";

test.tags("mobile");
test("mobile pipeline announces the outcome of a replay of offline changes", async () => {
    // Once `rejected` holds, the server rejects the replayed writes of "Desk Upgrade".
    let rejected = false;
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (rejected && args[0]?.[0] === 3) {
            throw makeServerError({ message: "Stage is locked" });
        }
    });
    const setOffline = mockOffline();
    await mountPipeline();
    // One region, present and empty until a replay ends.
    expect(PIPELINE_SYNC_STATUS).toHaveCount(1);
    expect(PIPELINE_SYNC_STATUS).toHaveAttribute("role", "status");
    expect(PIPELINE_SYNC_STATUS).toHaveClass("visually-hidden");
    expect(PIPELINE_SYNC_STATUS).toHaveText("");

    // A sync with nothing to replay announces nothing.
    await setOffline(true);
    await reconnect(setOffline);
    expect(PIPELINE_SYNC_STATUS).toHaveText("");

    // Replayed changes: their sync is announced, and the pipeline reloaded.
    await setOffline(true);
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    expect(PIPELINE_SYNC_STATUS).toHaveText("");
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(PIPELINE_SYNC_STATUS).toHaveText("Offline changes synced");

    // Changes queued again clear the region, so that the next outcome is announced
    // even when it reads the same.
    await setOffline(true);
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_stage`).select(
        String(QUALIFIED)
    );
    expect(PIPELINE_SYNC_STATUS).toHaveText("");
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(PIPELINE_SYNC_STATUS).toHaveText("Offline changes synced");

    // A rejected change stays parked: the failure is announced.
    rejected = true;
    await setOffline(true);
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(String(NEW));
    expect(PIPELINE_SYNC_STATUS).toHaveText("");
    await reconnect(setOffline);
    const [parked] = queued("crm.lead");
    expect(parked.args[0]).toEqual([3]);
    expect(parked.extras.error).toInclude("Stage is locked");
    expect(PIPELINE_SYNC_STATUS).toHaveText("Some offline changes failed to sync");
});

test.tags("mobile");
test("mobile pipeline clears the replay failure announcement once no parked change remains", async () => {
    // The server rejects every replayed write: each queued stage change is parked.
    onRpc("crm.lead", "web_save", () => {
        throw makeServerError({ message: "Stage is locked" });
    });
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    const badge = (name) => `${card(name)} .o_crm_mobile_pending_sync`;
    expect(PIPELINE_SYNC_STATUS).toHaveText("");

    // Offline, two cards move their lead to "Qualified": both replays are rejected,
    // and the failure is announced.
    await setOffline(true);
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_stage`).select(
        String(QUALIFIED)
    );
    await reconnect(setOffline);
    const parked = queued("crm.lead");
    expect(parked.map(({ args }) => args)).toEqual([
        [[3], { stage_id: QUALIFIED }],
        [[2], { stage_id: QUALIFIED }],
    ]);
    expect(parked.every(({ extras }) => extras.error.includes("Stage is locked"))).toBe(true);
    expect(PIPELINE_SYNC_STATUS).toHaveText("Some offline changes failed to sync");
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(cardNames()).toEqual([
        "Conference Room",
        "Lamps",
        "Storage Racks",
        "Quote for Chairs",
        "Desk Upgrade",
    ]);
    expect(badge("Quote for Chairs")).toHaveText("Sync failed");
    expect(badge("Desk Upgrade")).toHaveText("Sync failed");

    // One discarded in the offline systray: the other stays parked, with "Sync
    // failed", so the failure is still announced.
    await discardFirstQueuedCall();
    expect(queued("crm.lead").map(({ args }) => args)).toEqual([[[2], { stage_id: QUALIFIED }]]);
    expect(cardNames()).toEqual(["Conference Room", "Lamps", "Storage Racks", "Quote for Chairs"]);
    expect(badge("Quote for Chairs")).toHaveText("Sync failed");
    expect(PIPELINE_SYNC_STATUS).toHaveText("Some offline changes failed to sync");

    // The last one discarded: no failure is left to announce, and the region stays,
    // empty, for the next outcome.
    await discardFirstQueuedCall();
    expect(queued("crm.lead")).toEqual([]);
    expect(PIPELINE_SYNC_STATUS).toHaveCount(1);
    expect(PIPELINE_SYNC_STATUS).toHaveAttribute("role", "status");
    expect(PIPELINE_SYNC_STATUS).toHaveText("");
});

test.tags("mobile");
test("mobile lead card open button is named after its lead and described by its partner, revenue and sync state", async () => {
    // The server rejects the replayed stage change of "Lamps" only.
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (args[0]?.[0] === 5) {
            throw makeServerError({ message: "Stage is locked" });
        }
    });
    const setOffline = mockOffline();
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    const open = (name) => `${card(name)} .o_crm_mobile_lead_open`;

    // Named after the lead alone, the button is described by the partner (or the
    // contact) and the revenue it shows, each with its label.
    expect(open("Office Design")).toHaveAttribute("aria-label", "Office Design");
    expect(describedBy(open("Office Design"))).toEqual([
        "Customer: Azure Interior, Expected revenue: $ 100.00",
    ]);
    expect(describedBy(open("Lamps"))).toEqual(["Contact: Lamp Buyer, Expected revenue: $ 50.00"]);
    expect(describedBy(open("Storage Racks"))).toEqual(["Expected revenue: $ 250.00"]);
    const describedByIds = queryAll(".o_crm_mobile_lead_open").map((el) =>
        el.getAttribute("aria-describedby")
    );
    expect(new Set(describedByIds).size).toBe(7);
    // Synced cards have no disabled control to explain.
    expect(".o_crm_mobile_lead_unavailable").toHaveCount(0);
    expect(
        ".o_crm_mobile_lead_card :is(.o_crm_mobile_lead_stage, .o_crm_mobile_lead_activities_button)[aria-describedby]"
    ).toHaveCount(0);

    // A queued write: the description ends with the state of the badge.
    await setOffline(true);
    await contains(`${card("Lamps")} .o_crm_mobile_lead_stage`).select(String(NEW));
    expect(describedBy(open("Lamps"))).toEqual([
        "Contact: Lamp Buyer, Expected revenue: $ 50.00, Pending sync",
    ]);
    expect(describedBy(open("Storage Racks"))).toEqual(["Expected revenue: $ 250.00"]);

    // Rejected on replay, the write is parked.
    await reconnect(setOffline);
    expect(describedBy(open("Lamps"))).toEqual([
        "Contact: Lamp Buyer, Expected revenue: $ 50.00, Sync failed",
    ]);
    expect(open("Lamps")).toHaveAttribute("aria-label", "Lamps");
});

test.tags("mobile");
test("mobile lead card: a provisional card tells why its controls are disabled", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 10, contact: "Ann Offline" });
    const provisional = ".o_crm_mobile_lead_card.o_crm_mobile_lead_card_provisional";
    expect(provisional).toHaveCount(1);

    // The disabled open button: its description, then the reason; the disabled
    // stage selector and activities button: the reason, one element of the card.
    expect(`${provisional} .o_crm_mobile_lead_open`).not.toBeEnabled();
    expect(`${provisional} .o_crm_mobile_lead_open`).toHaveAttribute("aria-label", "Offline Lead");
    expect(describedBy(`${provisional} .o_crm_mobile_lead_open`)).toEqual([
        "Contact: Ann Offline, Expected revenue: $ 10.00, Pending sync",
        "Available once synced",
    ]);
    for (const control of [".o_crm_mobile_lead_stage", ".o_crm_mobile_lead_activities_button"]) {
        expect(`${provisional} ${control}`).not.toBeEnabled();
        expect(describedBy(`${provisional} ${control}`)).toEqual(["Available once synced"]);
    }
    expect(`${provisional} .o_crm_mobile_lead_unavailable`).toHaveCount(1);

    // Synced: a server card, with nothing disabled to explain.
    await reconnect(setOffline);
    expect(provisional).toHaveCount(0);
    expect(describedBy(`${card("Offline Lead")} .o_crm_mobile_lead_open`)).toEqual([
        "Contact: Ann Offline, Expected revenue: $ 10.00",
    ]);
    expect(".o_crm_mobile_lead_unavailable").toHaveCount(0);
    for (const control of [".o_crm_mobile_lead_stage", ".o_crm_mobile_lead_activities_button"]) {
        expect(`${card("Offline Lead")} ${control}`).toBeEnabled();
        expect(`${card("Offline Lead")} ${control}`).not.toHaveAttribute("aria-describedby");
    }
});

test.tags("mobile");
test("mobile pipeline names its New button after the stage and labels the header numbers", async () => {
    await mountPipeline();
    const newButton = ".o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_new";
    // "New" stays visible, and starts the name, which tells the button apart from
    // the control panel's "New".
    expect(newButton).toHaveText("New");
    expect(newButton).toHaveAttribute("aria-label", "New lead in New");
    // The bare count and revenue are hidden from assistive technology, which reads
    // them, labelled, from the header's status region.
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(".o_crm_mobile_pipeline_summary").toHaveAttribute("aria-hidden", "true");
    expect(textOf(HEADER_STATUS)).toBe("Leads: 3, expected revenue: $ 600");
    expect(queryFirst(HEADER_STATUS).closest("[aria-hidden]")).toBe(null);

    await contains(".o_crm_mobile_pipeline_next").click();
    expect(newButton).toHaveText("New");
    expect(newButton).toHaveAttribute("aria-label", "New lead in Qualified");
    expect(".o_crm_mobile_pipeline_summary").toHaveAttribute("aria-hidden", "true");
    expect(textOf(HEADER_STATUS)).toBe("Leads: 3, expected revenue: $ 700");
});

test.tags("mobile");
test("mobile lead form names its Activities button after the lead", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(ACTION_ID, {
        clearBreadcrumbs: true,
        viewType: "form",
        props: { resId: 1 },
    });
    const button = ".o_crm_mobile_activities_button";
    // An icon button, as the card's: its "Activities" title is the visible hint, and
    // its accessible name adds the lead.
    expect(button).toHaveText("");
    expect(`${button} > i.fa-clock-o`).toHaveAttribute("aria-hidden", "true");
    expect(button).toHaveAttribute("title", "Activities");
    expect(button).toHaveAttribute("aria-label", "Activities: Office Design");

    // The name follows the lead's name as it is edited, down to the plain label.
    await contains(".o_field_widget[name=name] input").edit("Office Design Plus");
    expect(button).toHaveAttribute("aria-label", "Activities: Office Design Plus");
    await contains(".o_field_widget[name=name] input").clear();
    expect(button).toHaveAttribute("aria-label", "Activities");
    expect(button).toHaveAttribute("title", "Activities");
});

test.tags("mobile");
test("mobile lead card stage selector and activity form controls have a field name, an id and a visible label", async () => {
    await mountPipeline();

    // Every card's stage selector carries the field name, as the quick create's does;
    // a name may repeat across cards, so no per-card id is needed.
    const stageSelects = queryAll(".o_crm_mobile_lead_card .o_crm_mobile_lead_stage");
    expect(stageSelects).toHaveLength(3);
    for (const select of stageSelects) {
        expect(select).toHaveAttribute("name", "stage_id");
    }

    // Each control of the inline activity form has its field name, an id unique in
    // the document, and a visible label that is its only accessible name.
    await openActivities("Office Design");
    await contains(".o_crm_mobile_log_call").click();
    const controls = [
        [".o_crm_mobile_activity_type", "activity_type_id", "Activity type"],
        [".o_crm_mobile_activity_summary", "summary", "Summary"],
        [".o_crm_mobile_activity_date", "date_deadline", "Due date"],
        [".o_crm_mobile_activity_user", "user_id", "Assigned to"],
    ];
    const ids = [];
    for (const [selector, name, labelText] of controls) {
        const control = queryFirst(`.o_crm_mobile_activity_form ${selector}`);
        expect(control).toHaveAttribute("name", name);
        expect(control).not.toHaveAttribute("aria-label");
        expect(control.id).not.toBe("");
        expect(queryAll(`[id="${control.id}"]`)).toHaveLength(1);
        const label = `.o_crm_mobile_activity_form label.form-label[for="${control.id}"]`;
        expect(label).toHaveCount(1);
        expect(label).toBeVisible();
        expect(label).toHaveText(labelText);
        expect([...control.labels].map((el) => el.textContent.trim())).toEqual([labelText]);
        ids.push(control.id);
    }
    expect(new Set(ids).size).toBe(controls.length);
    expect(".o_crm_mobile_activity_summary").toHaveAttribute("autocomplete", "off");
});

test.tags("mobile");
test("mobile lead card stage move queues offline", async () => {
    const received = receivedCalls("crm.lead", "web_save");
    const setOffline = mockOffline();
    await mountPipeline();
    // Both stages visited online.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();

    await setOffline(true);
    const calls = trackCalls();
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);
    expect(headerTexts()).toEqual(["New", "2", "$ 300"]);
    const [move] = queued("crm.lead");
    expect(move.method).toBe("web_save");
    expect(move.args[0]).toEqual([3]);
    expect(move.args[1]).toEqual({ stage_id: QUALIFIED });
    // The record's save, in the context of the record: the pipeline context and the
    // `default_stage_id` the framework gives the stage group the lead was loaded in,
    // queued with the id of the session user.
    const moveCall = {
        model: "crm.lead",
        method: "web_save",
        args: [[3], { stage_id: QUALIFIED }],
        kwargs: {
            context: {
                ...user.context,
                ...PIPELINE_CONTEXT,
                default_stage_id: NEW,
                [CRM_OFFLINE_UID_KEY]: user.userId,
            },
            specification: {},
        },
    };
    expect(queued("crm.lead").map(ormCall)).toEqual([moveCall]);

    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 1,000"]);
    expect(cardNames()).toEqual(["Desk Upgrade", "Conference Room", "Lamps", "Storage Racks"]);
    expect(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).toHaveValue(String(QUALIFIED));
    expect(textOf(`${card("Desk Upgrade")} .o_crm_mobile_pending_sync`)).toBe("Pending sync");
    // Only the framework's record save, which tries the server before queueing the
    // call on the lost connection: no rainbowman lookup, no other request.
    expect(calls).toEqual(["crm.lead/web_save"]);

    // Replayed: the server receives the queued call once, and no other write.
    const replayStart = calls.length;
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(received).toEqual([moveCall]);
    expect(calls.slice(replayStart).filter((call) => WRITE_CALL.test(call))).toEqual([
        "crm.lead/web_save",
    ]);
});

/** Message of the framework's queue outside a secure context. */
const NON_SECURE_CONTEXT_MESSAGE = "Offline features not available in a non-secure context";

/**
 * Serves the pipeline as from a non-secure origin (plain http on a network
 * address): the framework queue then refuses every call it is given.
 */
function mockNonSecureContext() {
    patchWithCleanup(window, { isSecureContext: false });
}

/**
 * Waits until mail's start-up store fetch has completed, as `mockOffline` does
 * before going offline: under CPU throttling or on a loaded host, that debounced
 * `/mail/store` request may only leave once the connection is cut, and its
 * unhandled failure would join the errors the test declares.
 */
async function waitForMailStartupFetch() {
    const store = getService("mail.store");
    if (store.initialized) {
        await store.isReadyPromise;
    }
}

/**
 * Cuts the connection as the offline tour does, every request failing with an
 * `error` event, but dispatched from its `send`: the failure then comes before
 * the next rendering, as a network failure faster than a frame does. The
 * returned function restores the connection. Await `waitForMailStartupFetch`
 * first.
 *
 * @returns {() => void}
 */
function cutConnectionAtSend() {
    const XHR = browser.XMLHttpRequest;
    let cut = true;
    patchWithCleanup(browser, {
        XMLHttpRequest: class extends XHR {
            send() {
                if (cut) {
                    this.dispatchEvent(new Event("error"));
                    return;
                }
                return super.send(...arguments);
            }
        },
    });
    return () => {
        cut = false;
    };
}

/**
 * Stage of a lead on the mock server, as `[{id, stage_id}]` (`[]` once deleted).
 *
 * @param {number} leadId
 */
function serverStage(leadId) {
    return MockServer.env["crm.lead"].search_read([["id", "=", leadId]], ["stage_id"]);
}

/**
 * Asserts that "Desk Upgrade" (3, $ 300) shows in "New" and not in "Qualified",
 * with both stage headers at their server values, its stage selector on "New",
 * no pending badge and nothing queued. Ends on the "New" stage.
 */
async function expectDeskUpgradeInNew() {
    const select = `${card("Desk Upgrade")} .o_crm_mobile_lead_stage`;
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(select).toHaveValue(String(NEW));
    expect(`${card("Desk Upgrade")} .o_crm_mobile_pending_sync`).toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "3", "$ 700"]);
    expect(cardNames()).toEqual(["Conference Room", "Lamps", "Storage Racks"]);
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
}

test.tags("mobile");
test("mobile lead card stage move rejected by the server keeps the lead in its stage", async () => {
    expect.errors(1);
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (args[1]?.stage_id === QUALIFIED) {
            throw makeServerError({ message: "Stage is locked" });
        }
    });
    await mountPipeline();
    // Both stages visited online.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();

    // The server rejects the move: the framework reports it in its own dialog,
    // and the lead stays where the server keeps it.
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    await waitFor(".o_error_dialog:contains(Stage is locked)");
    expect(".o_error_dialog").toHaveCount(1);
    expect.verifyErrors(["Stage is locked"]);
    await contains(".o_error_dialog .modal-footer .btn-primary").click();
    expect(".o_error_dialog").toHaveCount(0);
    await expectDeskUpgradeInNew();
    expect(serverStage(3)).toEqual([{ id: 3, stage_id: [NEW, "New"] }]);
});

test.tags("mobile");
test("mobile lead card stage move of a lead deleted on the server leaves no card in the target stage", async () => {
    expect.errors(1);
    // The server refuses to write a deleted lead, as `write` on a missing record does.
    onRpc("crm.lead", "web_save", function ({ args }) {
        const [ids] = args;
        if (this.env["crm.lead"].search_count([["id", "in", ids]]) < ids.length) {
            throw makeServerError({
                type: "MissingError",
                message: "Record does not exist or has been deleted.",
            });
        }
    });
    await mountPipeline();
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();

    // Deleted elsewhere while this pipeline still shows it, then moved here: the
    // framework reports the missing record in its own notification, and its revert
    // puts the card back in its stage, as on a desktop kanban.
    MockServer.env["crm.lead"].unlink([3]);
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    await waitFor(".o_notification:contains(cannot be found)");
    expect(".o_notification_content").toHaveText(
        "It seems the records with IDs 3 cannot be found. They might have been deleted."
    );
    expect.verifyErrors(["It seems the records with IDs 3 cannot be found"]);
    await expectDeskUpgradeInNew();
    expect(serverStage(3)).toEqual([]);
});

test.tags("mobile");
test("mobile lead card stage move refused by the queue outside a secure context keeps the lead in its stage", async () => {
    expect.errors(1);
    mockNonSecureContext();
    const setOffline = mockOffline();
    await mountPipeline();
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();

    // The connection drops on the move's save, and the framework cannot queue it:
    // its notification says so, and the lead is not shown as moved, its selector
    // included.
    await waitForMailStartupFetch();
    const reconnectAtSend = cutConnectionAtSend();
    await contains(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    await waitFor(`.o_notification:contains(${NON_SECURE_CONTEXT_MESSAGE})`);
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    expect.verifyErrors([NON_SECURE_CONTEXT_MESSAGE]);
    await expectDeskUpgradeInNew();

    // Reconnected without a reload: nothing was saved or replayed, and the screen
    // still matches the server.
    reconnectAtSend();
    await setOffline(false);
    await expectDeskUpgradeInNew();
    expect(serverStage(3)).toEqual([{ id: 3, stage_id: [NEW, "New"] }]);
});

test.tags("mobile");
test("mobile lead card of an ungrouped list keeps its stage when the move is neither saved nor queued", async () => {
    expect.errors(1);
    mockNonSecureContext();
    const setOffline = mockOffline();
    // A card field the record must fill before it is saved: "Desk Upgrade" has no
    // contact name, so the framework refuses to save it.
    const arch = leadsArch.replace(
        `<field name="contact_name"/>`,
        `<field name="contact_name" required="1"/>`
    );
    await mountPipeline({ arch, groupBy: [] });
    const calls = trackCalls();
    const lamps = `${card("Lamps")} .o_crm_mobile_lead_stage`;
    const desk = `${card("Desk Upgrade")} .o_crm_mobile_lead_stage`;
    const stageChoices = queryAllTexts(`${lamps} option`);
    const expectUnmoved = () => {
        expect(cardNames()).toHaveLength(7);
        expect(lamps).toHaveValue(String(QUALIFIED));
        expect(desk).toHaveValue(String(NEW));
        expect(".o_crm_mobile_lead_card .o_crm_mobile_pending_sync").toHaveCount(0);
        expect(queryAllTexts(`${lamps} option`)).toEqual(stageChoices);
        expect(queued("crm.lead")).toEqual([]);
    };

    // The connection drops on the save, and the framework cannot queue it: its
    // notification says so, and the card's selector returns to the lead's stage.
    await waitForMailStartupFetch();
    const reconnectAtSend = cutConnectionAtSend();
    await contains(lamps).select(String(NEW));
    await waitFor(`.o_notification:contains(${NON_SECURE_CONTEXT_MESSAGE})`);
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    expect.verifyErrors([NON_SECURE_CONTEXT_MESSAGE]);
    expectUnmoved();

    // Online, an invalid lead is neither saved nor queued: its selector returns too.
    reconnectAtSend();
    await setOffline(false);
    await contains(desk).select(String(QUALIFIED));
    await animationFrame();
    expectUnmoved();
    // Neither save reached the server.
    expect(calls.filter((call) => WRITE_CALL.test(call))).toEqual([]);
    expect(serverStage(5)).toEqual([{ id: 5, stage_id: [QUALIFIED, "Qualified"] }]);
    expect(serverStage(3)).toEqual([{ id: 3, stage_id: [NEW, "New"] }]);
});

test.tags("mobile");
test("mobile pipeline leaves Space and the arrow keys to the focused control", async () => {
    // The kanban card hotkeys the renderer inherits (card selection by Space, card
    // navigation by the arrows) must not run on the mobile layout.
    patchWithCleanup(CrmMobilePipeline.prototype, {
        focusNextCard() {
            expect.step("focusNextCard");
            return super.focusNextCard(...arguments);
        },
        onSpaceKeyPress() {
            expect.step("onSpaceKeyPress");
            return super.onSpaceKeyPress(...arguments);
        },
    });
    await mountPipeline();
    // Keys that reach the window, where the hotkey service listens.
    const windowKeys = [];
    const onWindowKeydown = (ev) => windowKeys.push(ev.key);
    window.addEventListener("keydown", onWindowKeydown);
    after(() => window.removeEventListener("keydown", onWindowKeydown));

    const controls = [
        ".o_crm_mobile_pipeline_next",
        ".o_crm_mobile_pipeline_new",
        `${card("Desk Upgrade")} .o_crm_mobile_lead_open`,
        `${card("Desk Upgrade")} .o_crm_mobile_lead_stage`,
        `${card("Desk Upgrade")} .o_crm_mobile_lead_activities_button`,
    ];
    const keys = [" ", ["shift", " "], "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    for (const control of controls) {
        for (const keyStrokes of keys) {
            await contains(control).focus();
            const events = await press(keyStrokes);
            await animationFrame();
            // Not prevented: the browser activates the button (Space) or chooses the
            // selector's option (arrows). The focus stays (ArrowUp no longer goes to
            // the search bar).
            expect(events.filter((ev) => ev.defaultPrevented).map((ev) => ev.key)).toEqual([]);
            expect(control).toBeFocused();
        }
    }
    // Only the Shift keydowns went on to the hotkey service.
    expect(windowKeys.filter((key) => key !== "Shift")).toEqual([]);
    expect.verifySteps([]);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);

    // Every other key still does: Enter activates "Next stage", Escape goes on.
    await contains(".o_crm_mobile_pipeline_next").press("Enter");
    await contains(".o_crm_mobile_pipeline_next").press("Escape");
    expect(windowKeys.filter((key) => key !== "Shift")).toEqual(["Enter", "Escape"]);
    expect(headerTexts()[0]).toBe("Qualified");
    expect.verifySteps([]);
});

/**
 * Chooses the option of `stageId` on a card's stage selector as the browser does
 * at a key that selects another option of a closed `<select>` in place (an arrow
 * key, or a typed character): keydown, the option change with its `change`
 * event, then keyup.
 *
 * @param {string} select selector of the card's stage `<select>`
 * @param {string} key
 * @param {number} stageId
 */
async function chooseStageWithKey(select, key, stageId) {
    await contains(select).keyDown(key);
    const selectEl = queryFirst(select);
    selectEl.value = String(stageId);
    await manuallyDispatchProgrammaticEvent(selectEl, "change");
    await contains(select).keyUp(key);
}

test.tags("mobile");
test("mobile lead card saves a stage chosen with the keyboard once confirmed, and keeps the focus", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    // Both stages visited online.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();
    await setOffline(true);
    const stageSelect = (name) => `${card(name)} .o_crm_mobile_lead_stage`;
    /** Queued stage moves, `{leadId: stageId}`. */
    const queuedMoves = () =>
        Object.fromEntries(queued("crm.lead").map(({ args }) => [args[0][0], args[1].stage_id]));

    // A walk through the stages with the keyboard saves nothing: the selector
    // shows the choice.
    await chooseStageWithKey(stageSelect("Desk Upgrade"), "ArrowDown", QUALIFIED);
    await chooseStageWithKey(stageSelect("Desk Upgrade"), "ArrowDown", WON);
    expect(stageSelect("Desk Upgrade")).toHaveValue(String(WON));
    expect(queuedMoves()).toEqual({});
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);

    // Escape drops the choice and shows the lead's stage again; Enter then has
    // nothing to save and is left alone.
    await contains(stageSelect("Desk Upgrade")).press("Escape");
    expect(stageSelect("Desk Upgrade")).toHaveValue(String(NEW));
    const idleEnter = (await press("Enter")).get("keydown");
    await animationFrame();
    expect(idleEnter.defaultPrevented).toBe(false);
    expect(queuedMoves()).toEqual({});

    // Type-to-select, then Enter: the lead moves once. Its card was the last one:
    // the focus goes to the stage selector of the card before it.
    await chooseStageWithKey(stageSelect("Desk Upgrade"), "q", QUALIFIED);
    expect(queuedMoves()).toEqual({});
    const enter = (await press("Enter")).get("keydown");
    await animationFrame();
    expect(enter.defaultPrevented).toBe(true);
    expect(queuedMoves()).toEqual({ 3: QUALIFIED });
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);
    expect(headerTexts()).toEqual(["New", "2", "$ 300"]);
    expect(stageSelect("Quote for Chairs")).toBeFocused();

    // Leaving the selector saves the choice. Tab focused the card's activities
    // button, removed with the card: the focus goes to the card now at its place.
    await chooseStageWithKey(stageSelect("Office Design"), "ArrowDown", QUALIFIED);
    expect(queuedMoves()).toEqual({ 3: QUALIFIED });
    await press("Tab");
    await animationFrame();
    expect(queuedMoves()).toEqual({ 3: QUALIFIED, 1: QUALIFIED });
    expect(cardNames()).toEqual(["Quote for Chairs"]);
    expect(stageSelect("Quote for Chairs")).toBeFocused();

    // The stage's last card: the focus goes to the header's "New".
    await chooseStageWithKey(stageSelect("Quote for Chairs"), "ArrowDown", QUALIFIED);
    await press("Enter");
    await animationFrame();
    expect(queuedMoves()).toEqual({ 3: QUALIFIED, 1: QUALIFIED, 2: QUALIFIED });
    expect(cardNames()).toEqual([]);
    expect(".o_crm_mobile_pipeline_new").toBeFocused();

    // A focus the user moved on stays: leaving the selector for another card's
    // selector saves the choice, and that selector keeps the focus.
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(cardNames()).toEqual([
        "Quote for Chairs",
        "Office Design",
        "Desk Upgrade",
        "Conference Room",
        "Lamps",
        "Storage Racks",
    ]);
    await chooseStageWithKey(stageSelect("Lamps"), "ArrowUp", NEW);
    await contains(stageSelect("Conference Room")).focus();
    expect(queuedMoves()).toEqual({ 3: QUALIFIED, 1: QUALIFIED, 2: QUALIFIED, 5: NEW });
    expect(cardNames()).toEqual([
        "Quote for Chairs",
        "Office Design",
        "Desk Upgrade",
        "Conference Room",
        "Storage Racks",
    ]);
    expect(stageSelect("Conference Room")).toBeFocused();

    // A choice on the option list (pointer, touch) moves the lead at once.
    await contains(stageSelect("Storage Racks")).select(String(NEW));
    expect(queuedMoves()).toEqual({ 3: QUALIFIED, 1: QUALIFIED, 2: QUALIFIED, 5: NEW, 6: NEW });
    expect(cardNames()).toEqual([
        "Quote for Chairs",
        "Office Design",
        "Desk Upgrade",
        "Conference Room",
    ]);
});

test.tags("mobile");
test("mobile lead card shows a lead without stage on an unselectable None choice", async () => {
    await makeMockServer();
    MockServer.env["crm.lead"].write([5], { stage_id: false });
    const setOffline = mockOffline();
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    const select = `${card("Lamps")} .o_crm_mobile_lead_stage`;
    const selection = (selector) => queryAll(`${selector} option`).map((option) => option.selected);

    // No real stage is presented as the current one: "None" is, and cannot be chosen.
    expect(queryAllTexts(`${select} option`)).toEqual(["None", "New", "Qualified", "Won"]);
    expect(`${select} option:first-child`).toHaveAttribute("value", "");
    expect(`${select} option:first-child`).toHaveProperty("disabled", true);
    expect(selection(select)).toEqual([true, false, false, false]);
    expect(select).toHaveValue("");
    expect(select).toBeEnabled();
    // A lead with a stage has no such choice.
    const otherSelect = `${card("Storage Racks")} .o_crm_mobile_lead_stage`;
    expect(queryAllTexts(`${otherSelect} option`)).toEqual(["New", "Qualified", "Won"]);
    expect(selection(otherSelect)).toEqual([false, true, false]);

    // Choosing a stage still moves the lead: offline, its save is queued.
    await setOffline(true);
    await contains(select).select(String(QUALIFIED));
    const [save] = queued("crm.lead");
    expect(save.method).toBe("web_save");
    expect(save.args).toEqual([[5], { stage_id: QUALIFIED }]);
    expect(queryAllTexts(`${select} option`)).toEqual(["New", "Qualified", "Won"]);
    expect(select).toHaveValue(String(QUALIFIED));
    expect(`${card("Lamps")} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");
});

test.tags("mobile");
test("mobile lead card has no stage selector without stage choices", async () => {
    await makeMockServer();
    MockServer.env["crm.lead"].write(MockServer.env["crm.lead"].search([]), { stage_id: false });
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    // No loaded lead has a stage: no empty, enabled selector; the other controls stay.
    expect(".o_crm_mobile_lead_card").toHaveCount(7);
    expect(".o_crm_mobile_lead_stage").toHaveCount(0);
    expect(".o_crm_mobile_lead_card .o_crm_mobile_lead_open").toHaveCount(7);
    expect(".o_crm_mobile_lead_card .o_crm_mobile_lead_activities_button").toHaveCount(7);
});

/** Stage ids of no stage: unknown, negative and fractional. */
const UNOFFERED_STAGE_VALUES = ["999", "-1", "1.5"];

/**
 * Chooses `value` on a card's stage `<select>` through an option the card does
 * not render, appended as a tampered page would: the change reaches the card.
 *
 * @param {string} select selector of the card's stage `<select>`
 * @param {string} value
 */
async function selectCraftedStage(select, value) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    queryFirst(select).append(option);
    await contains(select).select(value);
}

test.tags("mobile");
test("mobile lead card ignores a stage choice that is not an offered stage", async () => {
    await makeMockServer();
    // An existing stage no loaded lead has: offered, as the grouped list shows it.
    const proposalId = MockServer.env["crm.stage"].create({ name: "Proposal", sequence: 4 });
    expandStageChoices();
    const setOffline = mockOffline();
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    await animationFrame();
    const calls = trackCalls();
    const select = `${card("Lamps")} .o_crm_mobile_lead_stage`;
    const badge = `${card("Lamps")} .o_crm_mobile_pending_sync`;
    const serverStage = () =>
        MockServer.env["crm.lead"].search_read([["id", "=", 5]], ["stage_id"]);
    expect(queryAllTexts(`${select} option`)).toEqual(["New", "Qualified", "Won", "Proposal"]);

    // Online, then offline: the ungrouped list saves a chosen stage on its record,
    // so a value that is no stage it offers is neither saved nor queued, and the
    // lead keeps its stage.
    for (const offline of [false, true]) {
        await setOffline(offline);
        for (const value of UNOFFERED_STAGE_VALUES) {
            await selectCraftedStage(select, value);
            expect(calls.filter((call) => call.startsWith("crm.lead/"))).toEqual([]);
            expect(queued("crm.lead")).toEqual([]);
            expect(badge).toHaveCount(0);
            expect(serverStage()).toEqual([{ id: 5, stage_id: [QUALIFIED, "Qualified"] }]);
        }
    }

    // An offered stage still moves the lead, the one no lead has included: offline,
    // its save is queued.
    await contains(select).select(String(proposalId));
    const [save] = queued("crm.lead");
    expect(save.method).toBe("web_save");
    expect(save.args).toEqual([[5], { stage_id: proposalId }]);
    expect(select).toHaveValue(String(proposalId));
    expect(badge).toHaveText("Pending sync");
});

test.tags("mobile");
test("mobile lead card moves an ungrouped lead to a stage no loaded lead has", async () => {
    const propositionId = await addPropositionStage();
    expandStageChoices();
    const received = receivedCalls("crm.lead", "web_save");
    const setOffline = mockOffline();
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    await animationFrame();
    const select = (name) => `${card(name)} .o_crm_mobile_lead_stage`;
    const serverStage = (id) =>
        MockServer.env["crm.lead"].search_read([["id", "=", id]], ["stage_id"])[0].stage_id;
    expect(queryAllTexts(`${select("Lamps")} option`)).toEqual(STAGES_IN_ORDER);

    // Online, the record saves the stage on the server.
    await contains(select("Lamps")).select(String(propositionId));
    await animationFrame();
    expect(received.map(({ args }) => args)).toEqual([[[5], { stage_id: propositionId }]]);
    expect(serverStage(5)).toEqual([propositionId, "Proposition"]);
    expect(select("Lamps")).toHaveValue(String(propositionId));
    expect(`${card("Lamps")} .o_crm_mobile_pending_sync`).toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);

    // Offline, the save is queued and shown pending, then replayed on reconnection.
    await setOffline(true);
    await contains(select("Office Design")).select(String(propositionId));
    expect(queued("crm.lead").map(({ method, args }) => [method, args])).toEqual([
        ["web_save", [[1], { stage_id: propositionId }]],
    ]);
    expect(select("Office Design")).toHaveValue(String(propositionId));
    expect(`${card("Office Design")} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");
    expect(serverStage(1)).toEqual([NEW, "New"]);
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(serverStage(1)).toEqual([propositionId, "Proposition"]);
    expect(select("Office Design")).toHaveValue(String(propositionId));
    expect(cardNames()).toHaveLength(7);
});

test.tags("mobile");
test("mobile pipeline card ignores a stage outside the stage groups", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    const calls = trackCalls();
    const select = `${card("Desk Upgrade")} .o_crm_mobile_lead_stage`;

    for (const value of UNOFFERED_STAGE_VALUES) {
        await selectCraftedStage(select, value);
        expect(calls).toEqual([]);
        expect(queued("crm.lead")).toEqual([]);
        expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
        expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
        expect(`${card("Desk Upgrade")} .o_crm_mobile_pending_sync`).toHaveCount(0);
    }
});

test.tags("mobile");
test("mobile lead card writes its server stage online while a rejected write shows another", async () => {
    expect.errors(1);
    const saves = [];
    onRpc("crm.lead", "web_save", ({ args }) => {
        saves.push({ ids: [...args[0]], vals: { ...args[1] } });
        if (args[1]?.stage_id === QUALIFIED) {
            throw makeServerError({ message: "Stage is locked" });
        }
    });
    const specs = rootSpecs();
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();

    // Offline, the form moves the lead to "Qualified"; the replay is rejected.
    await setOffline(true);
    await contains(STAGE_DROPDOWN_TOGGLE).click();
    await contains(".o-dropdown--menu .dropdown-item:contains(Qualified)").click();
    await contains(".o_form_button_save").click();
    await contains(".o_back_button").click();
    await reconnect(setOffline);
    const [parked] = queued("crm.lead");
    expect(parked.extras.error).toInclude("Stage is locked");
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(`${card("Office Design")} .o_crm_mobile_pending_sync`).toHaveText("Sync failed");

    // Online, choosing its server stage on the card writes it to the server and
    // reloads the pipeline; the rejected write stays parked until discarded.
    const rootLoads = specs.length;
    saves.splice(0);
    await contains(`${card("Office Design")} .o_crm_mobile_lead_stage`).select(String(NEW));
    await animationFrame();
    expect(saves).toEqual([{ ids: [1], vals: { stage_id: NEW } }]);
    expect(specs.length).toBeGreaterThan(rootLoads);
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([parked.key]);
    // The framework's own cached pipeline load, back from the offline form.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

test.tags("mobile");
test("mobile lead card: provisional card cannot be opened or given activities until synced", async () => {
    const setOffline = mockOffline();
    await mountPipeline({ selectRecord: (resId) => expect.step(`open ${resId}`) });
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 10, contact: "Ann Offline" });

    const provisional = ".o_crm_mobile_lead_card.o_crm_mobile_lead_card_provisional";
    expect(provisional).toHaveCount(1);
    expect(textOf(`${provisional} .o_crm_mobile_lead_name`)).toBe("Offline Lead");
    expect(textOf(`${provisional} .o_crm_mobile_lead_partner`)).toBe("Ann Offline");
    expect(textOf(`${provisional} .o_crm_mobile_pending_sync`)).toBe("Pending sync");
    expect(`${provisional} .o_crm_mobile_lead_stage`).toHaveValue(String(NEW));
    // Its open, stage and activities controls are disabled (the card's own state,
    // not the framework's offline state: they all carry `data-available-offline`).
    for (const control of [
        ".o_crm_mobile_lead_open",
        ".o_crm_mobile_lead_stage",
        ".o_crm_mobile_lead_activities_button",
    ]) {
        expect(`${provisional} ${control}`).toHaveAttribute("data-available-offline");
        expect(`${provisional} ${control}`).not.toBeEnabled();
    }
    expect(`${card("Office Design")} .o_crm_mobile_lead_open`).toBeEnabled();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect.verifySteps([]);

    // Synced: a server card, which opens and has its activity sheet.
    await reconnect(setOffline);
    expect(provisional).toHaveCount(0);
    expect(`${card("Offline Lead")} .o_crm_mobile_pending_sync`).toHaveCount(0);
    expect(`${card("Offline Lead")} .o_crm_mobile_lead_stage`).toBeEnabled();
    await openActivities("Offline Lead");
    expect(".o_crm_mobile_activity_row").toHaveCount(0);
    expect(".o_crm_mobile_log_call").toBeEnabled();
    await closeSheet();
    await contains(`${card("Offline Lead")} .o_crm_mobile_lead_open`).click();
    expect.verifySteps(["open 8"]);
});

test.tags("mobile");
test("mobile lead card: provisional card shows its revenue in the company currency, as synced cards do", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    // "Office Design" is a synced card of the same revenue.
    await quickCreateLead({ name: "Offline Lead", revenue: 100 });

    const provisional = ".o_crm_mobile_lead_card.o_crm_mobile_lead_card_provisional";
    const revenue = (selector) => textOf(`${selector} .o_crm_mobile_lead_revenue`);
    // The active company's currency, which the server gives the created lead.
    const currencyId = user.activeCompany.currency_id;
    const expected = formatMonetary(100, { currencyId }).replace(/\u00a0/g, " ");
    expect(expected).toInclude(getCurrency(currencyId).symbol);
    expect(provisional).toHaveCount(1);
    expect(revenue(provisional)).toBe(expected);
    expect(revenue(card("Office Design"))).toBe(expected);

    // Synced: the server card, in the lead's company currency, keeps the same text.
    await reconnect(setOffline);
    expect(provisional).toHaveCount(0);
    const [created] = MockServer.env["crm.lead"].search_read(OFFLINE_LEAD_DOMAIN, [
        "company_currency",
    ]);
    expect(created.company_currency[0]).toBe(currencyId);
    expect(revenue(card("Offline Lead"))).toBe(expected);
});

// -----------------------------------------------------------------------------
// Quick create (CrmMobileQuickCreate)
// -----------------------------------------------------------------------------

/** The six `crm.lead` fields of the quick-create sheet, in display order. */
const QUICK_CREATE_FIELDS = [
    "name",
    "contact_name",
    "phone",
    "email_from",
    "expected_revenue",
    "stage_id",
];

test.tags("mobile");
test("mobile quick create opens as bottom sheet with six offline fields", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await contains(".o_crm_mobile_pipeline_new").click();

    expect(".o_bottom_sheet form.o_crm_mobile_quick_create").toHaveCount(1);
    expect(".o_bottom_sheet .o_crm_mobile_quick_create_field").toHaveCount(6);
    expect(".o_bottom_sheet :is(input, select, textarea)").toHaveCount(6);
    const fieldEls = queryAll(".o_bottom_sheet .o_crm_mobile_quick_create_field");
    expect(fieldEls.map((el) => el.getAttribute("name"))).toEqual(QUICK_CREATE_FIELDS);
    for (const el of fieldEls) {
        expect(el).toHaveAttribute("data-available-offline");
        expect(el).toBeEnabled();
    }
    for (const button of [".o_crm_mobile_quick_create_save", ".o_crm_mobile_quick_create_cancel"]) {
        expect(button).toHaveAttribute("data-available-offline");
        expect(button).toBeEnabled();
    }
    expect(queryAllTexts("form.o_crm_mobile_quick_create select[name=stage_id] option")).toEqual([
        "New",
        "Qualified",
        "Won",
    ]);
    expect("form.o_crm_mobile_quick_create select[name=stage_id]").toHaveValue(String(NEW));
});

test.tags("mobile");
test("mobile quick create requires a name and closes on cancel", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await contains(".o_crm_mobile_pipeline_new").click();

    // Save with a blank name: the name is flagged and focused, nothing is queued.
    await contains("form.o_crm_mobile_quick_create input[name=name]").edit("   ", {
        confirm: false,
    });
    await contains(".o_crm_mobile_quick_create_save").click();
    expect(".o_bottom_sheet form.o_crm_mobile_quick_create").toHaveCount(1);
    expect("form.o_crm_mobile_quick_create input[name=name]").toHaveClass("is-invalid");
    expect("form.o_crm_mobile_quick_create input[name=name]").toHaveAttribute(
        "aria-invalid",
        "true"
    );
    expect("form.o_crm_mobile_quick_create input[name=name]").toBeFocused();
    expect(".o_crm_mobile_quick_create .invalid-feedback").toHaveText("A lead name is required.");
    // The error is announced when it appears, and describes the name input.
    expect(".o_crm_mobile_quick_create .invalid-feedback").toHaveAttribute("role", "alert");
    expect("form.o_crm_mobile_quick_create input[name=name]").toHaveAttribute(
        "aria-describedby",
        queryFirst(".o_crm_mobile_quick_create .invalid-feedback").id
    );
    expect(queued("crm.lead")).toEqual([]);

    await contains("form.o_crm_mobile_quick_create input[name=name]").edit("Draft", {
        confirm: false,
    });
    expect("form.o_crm_mobile_quick_create input[name=name]").not.toHaveClass("is-invalid");
    expect(".o_crm_mobile_quick_create .invalid-feedback").toHaveCount(0);

    await contains(".o_crm_mobile_quick_create_cancel").click();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_crm_mobile_lead_card_provisional").toHaveCount(0);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
});

test.tags("mobile");
test("mobile quick create queues a negative revenue, a free-form email and empty fields as false", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await contains(".o_crm_mobile_pipeline_new").click();
    const sheet = "form.o_crm_mobile_quick_create";
    const revenue = `${sheet} input[name=expected_revenue]`;
    const email = `${sheet} input[name=email_from]`;

    // Negative amounts are valid: the revenue input declares no minimum of 0, only
    // the range stored exactly in the enabled company's currency (two decimals).
    expect(revenue).toHaveAttribute("type", "number");
    expect(revenue).toHaveAttribute("min", "-1000000000000");
    expect(revenue).toHaveAttribute("max", "1000000000000");
    expect(revenue).toHaveAttribute("step", "any");
    // The email is free text typed on the email keyboard: no browser email rule.
    expect(email).toHaveAttribute("type", "text");
    expect(email).toHaveAttribute("inputmode", "email");
    expect(email).toHaveAttribute("autocomplete", "email");
    expect(email).toHaveAttribute("autocapitalize", "off");
    expect(email).toHaveAttribute("spellcheck", "false");

    await contains(`${sheet} input[name=name]`).edit("Refund Lead", { confirm: false });
    // A phone of blanks only, and no contact name: both are sent as false.
    await contains(`${sheet} input[name=phone]`).edit("   ", { confirm: false });
    await contains(email).edit("Jane <jane@example.com>", { confirm: false });
    // Pasted at once: typed key by key, a number input drops the lone "-".
    await contains(revenue).edit("-50", { instantly: true, confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();

    expect(".o_bottom_sheet").toHaveCount(0);
    expect(queued("crm.lead").map(({ args }) => args)).toEqual([
        [
            [],
            {
                name: "Refund Lead",
                contact_name: false,
                phone: false,
                email_from: "Jane <jane@example.com>",
                expected_revenue: -50,
                stage_id: NEW,
            },
        ],
    ]);
    // The provisional card shows the negative amount and, with no contact, no
    // partner label; the stage sum includes the amount.
    const provisional = ".o_crm_mobile_lead_card_provisional";
    expect(queryAllTexts(`${provisional} .o_crm_mobile_lead_name`)).toEqual(["Refund Lead"]);
    expect(`${provisional} .o_crm_mobile_lead_partner`).toHaveCount(0);
    expect(textOf(`${provisional} .o_crm_mobile_lead_revenue`)).toBe("$ -50.00");
    expect(headerTexts()).toEqual(["New", "4", "$ 550"]);
});

test.tags("mobile");
test("mobile quick create refuses an expected revenue beyond the range stored exactly", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await contains(".o_crm_mobile_pipeline_new").click();
    const sheet = "form.o_crm_mobile_quick_create";
    const name = `${sheet} input[name=name]`;
    const revenue = `${sheet} input[name=expected_revenue]`;
    const feedback = `${revenue} + .invalid-feedback`;

    // The name is checked first: with both invalid, only the name is flagged.
    await contains(revenue).edit("10000000000000", { instantly: true, confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    expect(name).toHaveClass("is-invalid");
    expect(revenue).not.toHaveClass("is-invalid");
    expect(`${sheet} .invalid-feedback`).toHaveCount(1);

    // 1e13 exceeds 1e12: the revenue is flagged, focused and described by an
    // announced message; nothing is queued and the sheet keeps the values.
    await contains(name).edit("Big Deal", { confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    expect(".o_bottom_sheet form.o_crm_mobile_quick_create").toHaveCount(1);
    expect(revenue).toHaveClass("is-invalid");
    expect(revenue).toHaveClass("o_field_invalid");
    expect(revenue).toHaveAttribute("aria-invalid", "true");
    expect(revenue).toBeFocused();
    expect(feedback).toHaveText(
        "Enter an amount between -1,000,000,000,000 and 1,000,000,000,000."
    );
    expect(feedback).toHaveAttribute("role", "alert");
    expect(revenue).toHaveAttribute("aria-describedby", queryFirst(feedback).id);
    expect(`${sheet} .invalid-feedback`).toHaveCount(1);
    expect(name).not.toHaveClass("is-invalid");
    expect(name).toHaveValue("Big Deal");
    expect(revenue).toHaveValue(10000000000000);
    expect(".o_crm_mobile_quick_create_save").toBeEnabled();
    expect(queued("crm.lead")).toEqual([]);

    // Editing the amount clears the error, and the limit itself is accepted.
    await contains(revenue).edit("1000000000000", { instantly: true, confirm: false });
    expect(revenue).not.toHaveClass("is-invalid");
    expect(revenue).not.toHaveAttribute("aria-invalid");
    expect(revenue).not.toHaveAttribute("aria-describedby");
    expect(`${sheet} .invalid-feedback`).toHaveCount(0);
    await contains(".o_crm_mobile_quick_create_save").click();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(queued("crm.lead").map(({ args }) => args)).toEqual([
        [[], quickCreateValues("Big Deal", 1000000000000)],
    ]);

    // With a single enabled company, the range follows the decimal places of its
    // currency: none here.
    expect(user.activeCompanies).toHaveLength(1);
    patchWithCleanup(getCurrency(user.activeCompany.currency_id), { digits: [69, 0] });
    await contains(".o_crm_mobile_pipeline_new").click();
    expect(revenue).toHaveAttribute("min", "-100000000000000");
    expect(revenue).toHaveAttribute("max", "100000000000000");
});

test.tags("mobile");
test("mobile quick create bounds the expected revenue by the most precise currency of the enabled companies", async () => {
    // Two enabled companies: the active one in a currency without cents, the other
    // in USD (cents). The server can give the lead the second one, through the
    // salesperson's team. Each server state change recreates the session user from
    // the cookie, and resets the cookie to the companies it finds: the companies are
    // set right after the cookie.
    cookie.set("cids", "1-2");
    serverState.companies = [
        { id: 1, name: "Hermit JP", sequence: 1, parent_id: false, child_ids: [], currency_id: 3 },
        { id: 2, name: "Hermit US", sequence: 2, parent_id: false, child_ids: [], currency_id: 1 },
    ];
    // The fixture partners were listed with the default single company: add the
    // partner of the second one, which its mock company record points to.
    mailModels.ResPartner._records = [
        ...mailModels.ResPartner._records,
        { id: 2, active: true, name: "Hermit US" },
    ];
    serverState.currencies = [
        ...serverState.currencies,
        { id: 3, name: "JPY", position: "before", symbol: "¥", digits: [69, 0] },
    ];
    expect(user.activeCompanies.map(({ id }) => id)).toEqual([1, 2]);
    expect(getCurrency(user.activeCompany.currency_id).digits).toEqual([69, 0]);
    expect(getCurrency(user.activeCompanies[1].currency_id).digits).toEqual([69, 2]);

    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await contains(".o_crm_mobile_pipeline_new").click();
    const sheet = "form.o_crm_mobile_quick_create";
    const revenue = `${sheet} input[name=expected_revenue]`;
    /** `[min, max]` attributes of the revenue input. */
    const range = () => ["min", "max"].map((name) => queryFirst(revenue).getAttribute(name));

    // The USD company's cents set the range, not the active company's currency.
    expect(range()).toEqual(["-1000000000000", "1000000000000"]);
    await contains(`${sheet} input[name=name]`).edit("Big Deal", { confirm: false });
    await contains(revenue).edit("10000000000000", { instantly: true, confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    expect(".o_bottom_sheet form.o_crm_mobile_quick_create").toHaveCount(1);
    expect(revenue).toHaveClass("is-invalid");
    expect(revenue).toHaveAttribute("aria-invalid", "true");
    expect(revenue).toBeFocused();
    expect(`${revenue} + .invalid-feedback`).toHaveText(
        "Enter an amount between -1,000,000,000,000 and 1,000,000,000,000."
    );
    expect(queued("crm.lead")).toEqual([]);

    // The limit itself is accepted.
    await contains(revenue).edit("1000000000000", { instantly: true, confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(queued("crm.lead").map(({ args }) => args)).toEqual([
        [[], quickCreateValues("Big Deal", 1000000000000)],
    ]);

    // Only when every enabled company's currency has no cents is the range wider.
    patchWithCleanup(user.activeCompanies[1], { currency_id: 3 });
    await contains(".o_crm_mobile_pipeline_new").click();
    expect(range()).toEqual(["-100000000000000", "100000000000000"]);
    await contains(".o_crm_mobile_quick_create_cancel").click();
    await animationFrame();

    // A currency the session does not list counts as two decimals.
    patchWithCleanup(user.activeCompanies[1], { currency_id: 99 });
    await contains(".o_crm_mobile_pipeline_new").click();
    expect(range()).toEqual(["-1000000000000", "1000000000000"]);
    await contains(".o_crm_mobile_quick_create_cancel").click();
    await animationFrame();

    // So does a session with no enabled company.
    patchWithCleanup(user, {
        get activeCompanies() {
            return [];
        },
    });
    await contains(".o_crm_mobile_pipeline_new").click();
    expect(range()).toEqual(["-1000000000000", "1000000000000"]);
});

test.tags("mobile");
test("mobile quick create closes once on a repeated cancel or a cancel after save", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    const sheet = "form.o_crm_mobile_quick_create";
    const cancel = ".o_crm_mobile_quick_create_cancel";
    await contains(".o_crm_mobile_pipeline_new").click();
    expect(document.body).toHaveClass("bottom-sheet-open");

    // Cancel activated twice before the sheet leaves the page, which happens only at
    // the next render.
    const cancelButton = queryFirst(cancel);
    cancelButton.click();
    cancelButton.click();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(document.body).not.toHaveClass("bottom-sheet-open");

    // Closed once: the bottom-sheet service still flags the next sheet it opens.
    await contains(".o_crm_mobile_pipeline_new").click();
    expect(`.o_bottom_sheet ${sheet}`).toHaveCount(1);
    expect(document.body).toHaveClass("bottom-sheet-open");

    // Cancel activated as soon as a successful Save has closed the sheet, while the
    // sheet is still displayed: the lead is queued once and nothing more is closed.
    await contains(`${sheet} input[name=name]`).edit("Saved Lead", { confirm: false });
    let cancelOnClosingSheet = null;
    const observer = new MutationObserver(() => {
        if (!cancelOnClosingSheet && !document.body.classList.contains("bottom-sheet-open")) {
            const button = queryFirst(cancel);
            cancelOnClosingSheet = { displayed: Boolean(button) };
            button?.click();
        }
    });
    observer.observe(document.body, { attributeFilter: ["class"] });
    after(() => observer.disconnect());
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();
    observer.disconnect();
    expect(cancelOnClosingSheet).toEqual({ displayed: true });
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(document.body).not.toHaveClass("bottom-sheet-open");
    expect(queued("crm.lead").map(({ args }) => args[1].name)).toEqual(["Saved Lead"]);
    expect(queryAllTexts(".o_crm_mobile_lead_card_provisional .o_crm_mobile_lead_name")).toEqual([
        "Saved Lead",
    ]);

    // Closed once: the next sheet is flagged while open and unflagged once closed.
    await contains(".o_crm_mobile_pipeline_new").click();
    expect(`.o_bottom_sheet ${sheet}`).toHaveCount(1);
    expect(document.body).toHaveClass("bottom-sheet-open");
    await contains(cancel).click();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(document.body).not.toHaveClass("bottom-sheet-open");
});

test.tags("mobile");
test("mobile quick create queues a create offline in two cached stages without an online create", async () => {
    const received = receivedCalls("crm.lead", "web_save");
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    // Only the pipeline is visited online (both stages); nothing is created online.
    await openAction(ACTION_ID);
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(".o_kanban_quick_create").toHaveCount(0);

    await setOffline(true);
    const calls = trackCalls();
    // In the displayed stage ("New"), with all six fields.
    await contains(".o_crm_mobile_pipeline_new").click();
    const sheet = "form.o_crm_mobile_quick_create";
    await contains(`${sheet} input[name=name]`).edit("Lead in New", { confirm: false });
    await contains(`${sheet} input[name=contact_name]`).edit("Ann Buyer", { confirm: false });
    await contains(`${sheet} input[name=phone]`).edit("+32 470 12 34 56", { confirm: false });
    await contains(`${sheet} input[name=email_from]`).edit("ann@example.com", { confirm: false });
    await contains(`${sheet} input[name=expected_revenue]`).edit("120", { confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("New");

    // In another stage ("Qualified"), chosen in the sheet: the pipeline shows it.
    await quickCreateLead({ name: "Lead in Qualified", revenue: 80, stageId: QUALIFIED });
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Qualified");

    const creates = queued("crm.lead");
    expect(creates).toHaveLength(2);
    for (const create of creates) {
        expect(create.method).toBe("web_save");
        expect(create.args[0]).toEqual([]);
        expect(create.kwargs.context.default_type).toBe("opportunity");
        expect(create.extras.actionId).toBe(ACTION_ID);
        expect(create.extras.viewType).toBe("kanban");
    }
    const newLeadValues = {
        name: "Lead in New",
        contact_name: "Ann Buyer",
        phone: "+32 470 12 34 56",
        email_from: "ann@example.com",
        expected_revenue: 120,
        stage_id: NEW,
    };
    const qualifiedLeadValues = {
        name: "Lead in Qualified",
        contact_name: false,
        phone: false,
        email_from: false,
        expected_revenue: 80,
        stage_id: QUALIFIED,
    };
    expect(creates[0].args[1]).toEqual(newLeadValues);
    expect(creates[1].args[1]).toEqual(qualifiedLeadValues);
    // Each quick create carries its own delivery key.
    const [newLeadKey, qualifiedLeadKey] = creates.map(
        ({ kwargs }) => kwargs.context[CRM_OFFLINE_CREATE_KEY]
    );
    expect(newLeadKey).toMatch(DELIVERY_KEY);
    expect(qualifiedLeadKey).toMatch(DELIVERY_KEY);
    expect(qualifiedLeadKey).not.toBe(newLeadKey);
    // Creates (no id) in the pipeline list context, which holds the action's
    // `default_type`, with the delivery key, the id of the session user and an empty
    // specification, in queue order.
    const createKwargs = (key) => ({
        context: {
            ...user.context,
            ...PIPELINE_CONTEXT,
            [CRM_OFFLINE_CREATE_KEY]: key,
            [CRM_OFFLINE_UID_KEY]: user.userId,
        },
        specification: {},
    });
    const createCalls = [
        {
            model: "crm.lead",
            method: "web_save",
            args: [[], newLeadValues],
            kwargs: createKwargs(newLeadKey),
        },
        {
            model: "crm.lead",
            method: "web_save",
            args: [[], qualifiedLeadValues],
            kwargs: createKwargs(qualifiedLeadKey),
        },
    ];
    expect(creates.map(ormCall)).toEqual(createCalls);

    // Each stage shows its provisional card with the pending indicator.
    const provisional = ".o_crm_mobile_lead_card_provisional";
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 780"]);
    expect(queryAllTexts(`${provisional} .o_crm_mobile_lead_name`)).toEqual(["Lead in Qualified"]);
    expect(textOf(`${provisional} .o_crm_mobile_pending_sync`)).toBe("Pending sync");
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(headerTexts()).toEqual(["New", "4", "$ 720"]);
    expect(queryAllTexts(`${provisional} .o_crm_mobile_lead_name`)).toEqual(["Lead in New"]);
    expect(textOf(`${provisional} .o_crm_mobile_lead_partner`)).toBe("Ann Buyer");
    expect(textOf(`${provisional} .o_crm_mobile_pending_sync`)).toBe("Pending sync");
    // Queued directly: no create, onchange or other request is attempted offline.
    expect(calls).toEqual([]);

    // Replayed in queue order: the server receives the two queued creates, and no
    // other write.
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(received).toEqual(createCalls);
    expect(calls.filter((call) => WRITE_CALL.test(call))).toEqual([
        "crm.lead/web_save",
        "crm.lead/web_save",
    ]);
});

/**
 * The values the quick-create sheet saves for a lead with a name and revenue only:
 * the empty optional fields are false.
 */
function quickCreateValues(name, revenue) {
    return {
        name,
        contact_name: false,
        phone: false,
        email_from: false,
        expected_revenue: revenue,
        stage_id: NEW,
    };
}

test.tags("mobile");
test("mobile quick create saves online once and reloads the pipeline", async () => {
    const saved = Promise.withResolvers();
    const saves = [];
    onRpc("crm.lead", "web_save", async ({ args, kwargs }) => {
        // Copied: the mock server completes the values it creates in place.
        saves.push({ ids: [...args[0]], vals: { ...args[1] }, context: kwargs.context });
        await saved.promise;
    });
    const specs = rootSpecs();
    await mountPipeline();
    const rootLoads = () => specs.filter(({ method }) => method === "web_read_group");
    expect(rootLoads()).toHaveLength(1);

    await contains(".o_crm_mobile_pipeline_new").click();
    await contains("form.o_crm_mobile_quick_create input[name=name]").edit("Online Lead", {
        confirm: false,
    });
    await contains("form.o_crm_mobile_quick_create input[name=expected_revenue]").edit("70", {
        confirm: false,
    });
    await contains(".o_crm_mobile_quick_create_save").click();
    // While the save runs, Save is disabled and a second submission is ignored.
    expect(".o_crm_mobile_quick_create_save").not.toBeEnabled();
    await manuallyDispatchProgrammaticEvent(queryFirst("form.o_crm_mobile_quick_create"), "submit");
    await animationFrame();
    expect(saves).toHaveLength(1);

    saved.resolve();
    await animationFrame();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(saves[0].ids).toEqual([]);
    expect(saves[0].vals).toEqual(quickCreateValues("Online Lead", 70));
    expect(saves[0].context.default_type).toBe("opportunity");
    expect(saves[0].context[CRM_OFFLINE_CREATE_KEY]).toMatch(DELIVERY_KEY);
    expect(queued("crm.lead")).toEqual([]);
    // The pipeline reloaded: the lead is a server card of an opportunity.
    expect(rootLoads()).toHaveLength(2);
    expect(headerTexts()).toEqual(["New", "4", "$ 670"]);
    expect(card("Online Lead")).not.toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(`${card("Online Lead")} .o_crm_mobile_pending_sync`).toHaveCount(0);
    const [lead] = MockServer.env["crm.lead"].search_read([["name", "=", "Online Lead"]], ["type"]);
    expect(lead.type).toBe("opportunity");
});

test.tags("mobile");
test("mobile quick create keeps the values on a server error and queues on a dropped connection", async () => {
    expect.errors(2);
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (args[1]?.name === "Rejected Lead") {
            throw makeServerError({ message: "Invalid lead" });
        }
    });
    let failRootReload = false;
    onRpc("crm.lead", "web_read_group", () => {
        if (failRootReload) {
            failRootReload = false;
            throw makeServerError({ message: "Pipeline reload failed" });
        }
    });
    const setOffline = mockOffline();
    const drops = dropConnections();
    await mountPipeline();

    // A server error: the sheet stays open with the entered values, nothing queued.
    await quickCreateLead({ name: "Rejected Lead", revenue: 20 });
    await animationFrame();
    expect(".o_bottom_sheet form.o_crm_mobile_quick_create").toHaveCount(1);
    expect("form.o_crm_mobile_quick_create input[name=name]").toHaveValue("Rejected Lead");
    expect("form.o_crm_mobile_quick_create input[name=expected_revenue]").toHaveValue(20);
    expect(".o_crm_mobile_quick_create_save").toBeEnabled();
    expect(queued("crm.lead")).toEqual([]);
    expect.verifyErrors(["Invalid lead"]);

    // The connection drops during the save: the create is queued instead.
    drops.add("crm.lead/web_save");
    await contains("form.o_crm_mobile_quick_create input[name=name]").edit("Dropped Lead", {
        confirm: false,
    });
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();
    expect(drops.size).toBe(0);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    const [create] = queued("crm.lead");
    expect(create.args).toEqual([[], quickCreateValues("Dropped Lead", 20)]);
    expect(create.kwargs.context.default_type).toBe("opportunity");
    expect(card("Dropped Lead")).toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(headerTexts()).toEqual(["New", "4", "$ 620"]);

    // Replayed once reconnected: a server card.
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(card("Dropped Lead")).not.toHaveClass("o_crm_mobile_lead_card_provisional");

    // Saved online while the pipeline reload drops: the lead exists on the server,
    // nothing is queued (no second create), and the sheet closes without error.
    drops.add("crm.lead/web_read_group");
    await quickCreateLead({ name: "Saved Lead", revenue: 5 });
    await animationFrame();
    expect(drops.size).toBe(0);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(MockServer.env["crm.lead"].search_count([["name", "=", "Saved Lead"]])).toBe(1);
    expect(queued("crm.lead")).toEqual([]);

    // A server error on that reload is not a lost connection: it is reported once,
    // and, the lead being created on the server, the sheet closes, so its values
    // cannot be saved a second time.
    await reconnect(setOffline);
    failRootReload = true;
    await quickCreateLead({ name: "Reloaded Lead", revenue: 6 });
    await animationFrame();
    expect(failRootReload).toBe(false);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(MockServer.env["crm.lead"].search_count([["name", "=", "Reloaded Lead"]])).toBe(1);
    expect(queued("crm.lead")).toEqual([]);
    expect.verifyErrors(["Pipeline reload failed"]);
});

/**
 * Emulates the server's lead create by delivery key (the `crm.lead` `web_save`
 * override): a create (`web_save` without ids) whose context carries the key
 * (`CRM_OFFLINE_CREATE_KEY`) of a lead already created answers with that lead and
 * creates nothing. The mock server also loses the answer of the next lead creates,
 * one per value pushed to the returned `losses`: the server handles the create, then
 * its answer reaches the page as a lost connection (a 502). Each create is stepped
 * as `create <name>`, or `create <name> (delivered)` when its key answered it, with
 * ` (answer lost)` appended when its answer is lost; its payload (`ormCall`) is
 * appended to `received`.
 *
 * @returns {{losses: true[], received: Object[]}}
 */
function mockLeadCreatesByKey() {
    const state = { losses: [], received: [] };
    const leadIdsByKey = new Map();
    onRpc("crm.lead", "web_save", async (call) => {
        const { args, kwargs, parent } = call;
        if (args[0].length) {
            return;
        }
        state.received.push(JSON.parse(JSON.stringify(ormCall(call))));
        const key = kwargs.context?.[CRM_OFFLINE_CREATE_KEY];
        let step = `create ${args[1].name}`;
        let result;
        if (leadIdsByKey.has(key)) {
            step += " (delivered)";
            result = [{ id: leadIdsByKey.get(key) }];
        } else {
            result = await parent();
            if (typeof key === "string") {
                leadIdsByKey.set(key, result[0].id);
            }
        }
        if (state.losses.length && state.losses.shift()) {
            expect.step(`${step} (answer lost)`);
            return new Response("", { status: 502 });
        }
        expect.step(step);
        return result;
    });
    return state;
}

/** Number of server leads named `name`. */
function countLeads(name) {
    return MockServer.env["crm.lead"].search_count([["name", "=", name]]);
}

test.tags("mobile");
test("mobile quick create whose replay answer is lost is sent again with its key and created once", async () => {
    const server = mockLeadCreatesByKey();
    const lookups = receivedCalls("crm.lead", "search");
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await quickCreateLead({ name: "Lost Lead", revenue: 30 });
    expect(headerTexts()).toEqual(["New", "4", "$ 630"]);
    // Queued with a new delivery key and the id of the session user in the pipeline
    // list context.
    const [create] = queued("crm.lead");
    const key = create.kwargs.context[CRM_OFFLINE_CREATE_KEY];
    expect(key).toMatch(DELIVERY_KEY);
    const createCall = {
        model: "crm.lead",
        method: "web_save",
        args: [[], quickCreateValues("Lost Lead", 30)],
        kwargs: {
            context: {
                ...user.context,
                ...PIPELINE_CONTEXT,
                [CRM_OFFLINE_CREATE_KEY]: key,
                [CRM_OFFLINE_UID_KEY]: user.userId,
            },
            specification: {},
        },
    };
    expect(ormCall(create)).toEqual(createCall);

    // The replay's create reaches the server, which creates the lead, but its answer
    // is lost: the create stays queued, unparked and unchanged, with its provisional
    // card.
    server.losses.push(true);
    await setOffline(false);
    await expect.waitForSteps(["create Lost Lead (answer lost)"]);
    await animationFrame();
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    expect(countLeads("Lost Lead")).toBe(1);
    const [kept] = queued("crm.lead");
    expect(ormCall(kept)).toEqual(createCall);
    expect(kept.extras.error).toBe(undefined);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade", "Lost Lead"]);
    expect(card("Lost Lead")).toHaveClass("o_crm_mobile_lead_card_provisional");

    // Reconnected, the replay sends the very same call, which the server answers with
    // the lead it created: one server card, counted once in the header. No lookup.
    await reconnect(setOffline);
    expect.verifySteps(["create Lost Lead (delivered)"]);
    expect(server.received).toHaveLength(2);
    expect(server.received[1]).toEqual(server.received[0]);
    expect(server.received[0].kwargs.context[CRM_OFFLINE_CREATE_KEY]).toBe(key);
    expect(lookups).toEqual([]);
    expect(countLeads("Lost Lead")).toBe(1);
    expect(queued("crm.lead")).toEqual([]);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade", "Lost Lead"]);
    expect(card("Lost Lead")).not.toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(`${card("Lost Lead")} .o_crm_mobile_pending_sync`).toHaveCount(0);
    expect(headerTexts()).toEqual(["New", "4", "$ 630"]);
});

test.tags("mobile");
test("mobile quick create whose online answer is lost queues the key it sent and is created once", async () => {
    const server = mockLeadCreatesByKey();
    const lookups = receivedCalls("crm.lead", "search");
    const setOffline = mockOffline();
    await mountPipeline();

    // Saved online, the server creates the lead but its answer is lost: the create is
    // queued with the delivery key the online save sent, shown as a provisional card.
    server.losses.push(true);
    await quickCreateLead({ name: "Lost Lead", revenue: 30 });
    await expect.waitForSteps(["create Lost Lead (answer lost)"]);
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    expect(countLeads("Lost Lead")).toBe(1);
    const [sent] = server.received;
    const key = sent.kwargs.context[CRM_OFFLINE_CREATE_KEY];
    expect(key).toMatch(DELIVERY_KEY);
    const [create] = queued("crm.lead");
    expect(ormCall(create)).toEqual({
        model: "crm.lead",
        method: "web_save",
        args: [[], quickCreateValues("Lost Lead", 30)],
        kwargs: {
            context: {
                ...user.context,
                ...PIPELINE_CONTEXT,
                [CRM_OFFLINE_CREATE_KEY]: key,
                [CRM_OFFLINE_UID_KEY]: user.userId,
            },
            specification: {},
        },
    });
    expect(create.extras.error).toBe(undefined);
    expect(card("Lost Lead")).toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(headerTexts()).toEqual(["New", "4", "$ 630"]);

    // Its replay sends the call the online save sent, queued with the id of the
    // session user, which the server answers with the lead it created: no second
    // lead, and no lookup.
    await reconnect(setOffline);
    expect.verifySteps(["create Lost Lead (delivered)"]);
    expect(server.received).toHaveLength(2);
    expect(server.received[1]).toEqual({
        ...sent,
        kwargs: {
            ...sent.kwargs,
            context: { ...sent.kwargs.context, [CRM_OFFLINE_UID_KEY]: user.userId },
        },
    });
    expect(lookups).toEqual([]);
    expect(countLeads("Lost Lead")).toBe(1);
    expect(queued("crm.lead")).toEqual([]);
    expect(card("Lost Lead")).not.toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade", "Lost Lead"]);
    expect(headerTexts()).toEqual(["New", "4", "$ 630"]);

    // A new quick create, saved online, carries a new key.
    await quickCreateLead({ name: "Next Lead", revenue: 5 });
    await expect.waitForSteps(["create Next Lead"]);
    expect(server.received[2].kwargs.context[CRM_OFFLINE_CREATE_KEY]).toMatch(DELIVERY_KEY);
    expect(server.received[2].kwargs.context[CRM_OFFLINE_CREATE_KEY]).not.toBe(key);
    expect(countLeads("Next Lead")).toBe(1);
    expect(queued("crm.lead")).toEqual([]);
});

const QUICK_CREATE_STAGE = "form.o_crm_mobile_quick_create select[name=stage_id]";

/**
 * Selects the second stage option of the open quick-create sheet with its value
 * replaced by `value`, as a tampered page would submit it.
 *
 * @param {string} value
 */
async function selectTamperedStage(value) {
    queryAll(`${QUICK_CREATE_STAGE} option`)[1].value = value;
    await contains(QUICK_CREATE_STAGE).select(value);
}

/** Records the `stage_id` of every quick-create save the sheet hands to the pipeline. */
function trackQuickCreateSaves() {
    const stageIds = [];
    patchWithCleanup(CrmMobilePipeline.prototype, {
        onQuickCreateSave(values) {
            stageIds.push(values.stage_id);
            return super.onQuickCreateSave(...arguments);
        },
    });
    return stageIds;
}

/**
 * Asserts that the open sheet refused its stage: the stage is flagged, focused
 * and described by an announced message, and the entered values are kept.
 *
 * @param {string} name
 * @param {number} revenue
 */
function expectStageRefused(name, revenue) {
    const feedback = `${QUICK_CREATE_STAGE} + .invalid-feedback`;
    expect(".o_bottom_sheet form.o_crm_mobile_quick_create").toHaveCount(1);
    expect(QUICK_CREATE_STAGE).toHaveClass("is-invalid");
    expect(QUICK_CREATE_STAGE).toHaveAttribute("aria-invalid", "true");
    expect(QUICK_CREATE_STAGE).toBeFocused();
    expect(feedback).toHaveText("Select a stage from the list.");
    expect(feedback).toHaveAttribute("role", "alert");
    expect(QUICK_CREATE_STAGE).toHaveAttribute("aria-describedby", queryFirst(feedback).id);
    expect(".o_crm_mobile_quick_create .invalid-feedback").toHaveCount(1);
    expect("form.o_crm_mobile_quick_create input[name=name]").toHaveValue(name);
    expect("form.o_crm_mobile_quick_create input[name=expected_revenue]").toHaveValue(revenue);
    expect(".o_crm_mobile_quick_create_save").toBeEnabled();
}

test.tags("mobile");
test("mobile quick create refuses a stage value that is not an offered stage", async () => {
    const saves = trackQuickCreateSaves();
    const setOffline = mockOffline();
    const calls = trackCalls();
    await mountPipeline();
    // An existing stage that the pipeline does not offer: no lead, so no group.
    const hiddenStageId = MockServer.env["crm.stage"].create({ name: "Hidden", sequence: 4 });
    await contains(".o_crm_mobile_pipeline_new").click();
    await contains("form.o_crm_mobile_quick_create input[name=name]").edit("Tampered Lead", {
        confirm: false,
    });
    await contains("form.o_crm_mobile_quick_create input[name=expected_revenue]").edit("40", {
        confirm: false,
    });

    // Online: negative, fractional, nonfinite, non-numeric and unoffered values.
    for (const value of ["-1", "1.5", "Infinity", "abc", String(hiddenStageId)]) {
        await selectTamperedStage(value);
        // Changing the stage clears the previous refusal.
        expect(QUICK_CREATE_STAGE).not.toHaveClass("is-invalid");
        expect(".o_crm_mobile_quick_create .invalid-feedback").toHaveCount(0);
        await contains(".o_crm_mobile_quick_create_save").click();
        expectStageRefused("Tampered Lead", 40);
    }
    // Refused by the sheet itself, before `onSave`.
    expect(saves).toEqual([]);
    expect(calls).not.toInclude("crm.lead/web_save");

    // Offline: nothing is queued.
    await setOffline(true);
    await selectTamperedStage("-1");
    await contains(".o_crm_mobile_quick_create_save").click();
    expectStageRefused("Tampered Lead", 40);
    expect(saves).toEqual([]);
    expect(queued("crm.lead")).toEqual([]);

    // An offered stage clears the flag and creates the lead.
    await contains(QUICK_CREATE_STAGE).select(String(NEW));
    expect(QUICK_CREATE_STAGE).not.toHaveClass("is-invalid");
    expect(QUICK_CREATE_STAGE).not.toHaveAttribute("aria-invalid");
    expect(QUICK_CREATE_STAGE).not.toHaveAttribute("aria-describedby");
    expect(".o_crm_mobile_quick_create .invalid-feedback").toHaveCount(0);
    await contains(".o_crm_mobile_quick_create_save").click();
    expect(".o_bottom_sheet").toHaveCount(0);
    const creates = queued("crm.lead");
    expect(creates).toHaveLength(1);
    expect(creates[0].args).toEqual([[], quickCreateValues("Tampered Lead", 40)]);
    expect(creates[0].extras.changes.stage_id).toEqual({ id: NEW, display_name: "New" });
    expect(card("Tampered Lead")).toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(saves).toEqual([NEW]);
    expect(calls).not.toInclude("crm.lead/web_save");
});

test.tags("mobile");
test("mobile quick create refuses a stage removed from the pipeline while the sheet is open", async () => {
    let controller = null;
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    const saves = trackQuickCreateSaves();
    const setOffline = mockOffline();
    const calls = trackCalls();
    await mountPipeline();
    await contains(".o_crm_mobile_pipeline_new").click();
    await contains("form.o_crm_mobile_quick_create input[name=name]").edit("Late Lead", {
        confirm: false,
    });
    await contains("form.o_crm_mobile_quick_create input[name=expected_revenue]").edit("30", {
        confirm: false,
    });
    await contains(QUICK_CREATE_STAGE).select(String(WON));

    // The pipeline reloads with a search that leaves "Won" out (a same-search
    // reload keeps its emptied groups): the open sheet still lists it.
    await controller.model.load({ domain: [["stage_id", "!=", WON]] });
    await animationFrame();
    expect(controller.model.root.groups.map(({ value }) => value)).toEqual([NEW, QUALIFIED]);
    expect(queryAllTexts(`${QUICK_CREATE_STAGE} option`)).toEqual(["New", "Qualified", "Won"]);

    // Online, the pipeline refuses it: no request, the sheet keeps the values.
    await contains(".o_crm_mobile_quick_create_save").click();
    expectStageRefused("Late Lead", 30);
    expect(saves).toEqual([WON]);
    expect(calls).not.toInclude("crm.lead/web_save");
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("New");

    // Offline, nothing is queued.
    await setOffline(true);
    await contains(".o_crm_mobile_quick_create_save").click();
    expectStageRefused("Late Lead", 30);
    expect(queued("crm.lead")).toEqual([]);

    // Back online, a current stage creates the lead there, once.
    await setOffline(false);
    await contains(QUICK_CREATE_STAGE).select(String(QUALIFIED));
    expect(".o_crm_mobile_quick_create .invalid-feedback").toHaveCount(0);
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(saves).toEqual([WON, WON, QUALIFIED]);
    expect(calls.filter((call) => call === "crm.lead/web_save")).toHaveLength(1);
    expect(
        MockServer.env["crm.lead"].search_count([
            ["name", "=", "Late Lead"],
            ["stage_id", "=", QUALIFIED],
        ])
    ).toBe(1);
    expect(queued("crm.lead")).toEqual([]);
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Qualified");
    expect(card("Late Lead")).not.toHaveClass("o_crm_mobile_lead_card_provisional");
});

test.tags("mobile");
test("mobile quick create saves a lead without stage while the pipeline offers none", async () => {
    const saves = trackQuickCreateSaves();
    await makeMockServer();
    // No stage exists: every lead loses its stage, so the pipeline has the "None"
    // group only and offers no stage.
    MockServer.env["crm.stage"].unlink(MockServer.env["crm.stage"].search([]));
    const setOffline = mockOffline();
    await mountPipeline();
    expect(headerTexts()).toEqual(["None", "7", "$ 2,200"]);
    expect(".o_crm_mobile_pipeline_prev").toHaveAttribute("disabled");
    expect(".o_crm_mobile_pipeline_next").toHaveAttribute("disabled");

    await setOffline(true);
    const calls = trackCalls();
    await contains(".o_crm_mobile_pipeline_new").click();
    expect(`${QUICK_CREATE_STAGE} option`).toHaveCount(0);
    expect(QUICK_CREATE_STAGE).toHaveValue("");
    await contains("form.o_crm_mobile_quick_create input[name=name]").edit("Stageless Lead", {
        confirm: false,
    });
    await contains("form.o_crm_mobile_quick_create input[name=expected_revenue]").edit("60", {
        confirm: false,
    });
    await contains(".o_crm_mobile_quick_create_save").click();

    // Not refused: the sheet closes and the create is queued once, without stage.
    expect(".o_crm_mobile_quick_create .invalid-feedback").toHaveCount(0);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(saves).toEqual([false]);
    const creates = queued("crm.lead");
    expect(creates).toHaveLength(1);
    expect(creates[0].method).toBe("web_save");
    expect(creates[0].args).toEqual([
        [],
        { ...quickCreateValues("Stageless Lead", 60), stage_id: false },
    ]);
    expect(creates[0].kwargs.context.default_type).toBe("opportunity");
    expect(creates[0].extras.changes.stage_id).toBe(false);
    expect(card("Stageless Lead")).toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(headerTexts()).toEqual(["None", "8", "$ 2,260"]);
    expect(calls).toEqual([]);

    // The replay creates the lead without stage on the server.
    await reconnect(setOffline);
    expect(
        MockServer.env["crm.lead"].search_count([
            ["name", "=", "Stageless Lead"],
            ["stage_id", "=", false],
        ])
    ).toBe(1);
    expect(queued("crm.lead")).toEqual([]);
    expect(card("Stageless Lead")).not.toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(headerTexts()).toEqual(["None", "8", "$ 2,260"]);
});

/**
 * Whether the open bottom sheet is fully expanded: its rail is scrolled to its end,
 * where the sheet's bottom edge is the viewport's.
 */
function isSheetExpanded() {
    const rail = queryFirst(".o_bottom_sheet_rail");
    return Math.abs(rail.scrollHeight - rail.clientHeight - rail.scrollTop) <= 1;
}

/**
 * Asserts that `selectors` are buttons of equal width, side by side in one row, all
 * in view in the open bottom sheet.
 *
 * @param {string[]} selectors
 */
function expectEqualButtonsInView(selectors) {
    const rail = queryFirst(".o_bottom_sheet_rail").getBoundingClientRect();
    const sheet = queryFirst(".o_bottom_sheet_sheet").getBoundingClientRect();
    const rects = selectors.map((selector) => queryFirst(selector).getBoundingClientRect());
    for (const [index, rect] of rects.entries()) {
        const inView =
            rect.top >= Math.max(rail.top, sheet.top) &&
            rect.bottom <= Math.min(rail.bottom, sheet.bottom) + 1;
        expect(inView).toBe(true, { message: `${selectors[index]} in view` });
        expect(Math.round(rect.width)).toBe(Math.round(rects[0].width));
        expect(Math.round(rect.top)).toBe(Math.round(rects[0].top));
    }
}

test.tags("mobile");
test("mobile quick create keeps Save and Cancel in view and styles its fields alike", async () => {
    await mountPipeline();
    const stageSelectFontSize = getComputedStyle(queryFirst(".o_crm_mobile_lead_stage")).fontSize;
    await contains(".o_crm_mobile_pipeline_new").click();
    const buttons = [".o_crm_mobile_quick_create_save", ".o_crm_mobile_quick_create_cancel"];
    expect(".o_crm_mobile_quick_create_buttons").toHaveStyle({ position: "sticky" });
    expect(isSheetExpanded()).toBe(true);
    expectEqualButtonsInView(buttons);

    // The inputs and the select share one radius, one font size (also the card stage
    // select's) and one focus ring.
    const fields = queryAll(".o_bottom_sheet .o_crm_mobile_quick_create_field");
    expect(fields).toHaveLength(6);
    const [first] = fields;
    const { borderRadius, fontSize } = getComputedStyle(first);
    expect(borderRadius).not.toBe("0px");
    expect(fontSize).toBe(stageSelectFontSize);
    first.focus();
    await animationFrame();
    const { boxShadow } = getComputedStyle(first);
    expect(boxShadow).not.toBe("none");
    for (const field of fields) {
        expect(field).toHaveStyle({ borderRadius, fontSize });
        field.focus();
        await animationFrame();
        expect(field).toHaveStyle({ boxShadow });
    }
    first.focus();
    await animationFrame();

    // The required name is outlined darker than the optional fields, as the
    // framework's phone form outlines its required fields, while it is neither
    // focused nor invalid.
    const name = "form.o_crm_mobile_quick_create input[name=name]";
    const contactName = "form.o_crm_mobile_quick_create input[name=contact_name]";
    const phone = "form.o_crm_mobile_quick_create input[name=phone]";
    const requiredBorder = { borderColor: "rgb(33, 37, 41)" };
    expect(name).not.toHaveStyle(requiredBorder);
    queryFirst(contactName).focus();
    await animationFrame();
    expect(name).toHaveStyle(requiredBorder);
    expect(contactName).not.toHaveStyle(requiredBorder);
    expect(phone).not.toHaveStyle(requiredBorder);

    // The name's message grows the sheet: it stays expanded, Save and Cancel in
    // view, and the invalid name keeps Bootstrap's invalid outline and focus ring.
    await contains(".o_crm_mobile_quick_create_save").click();
    expect(name).toHaveClass("is-invalid");
    expect(name).toBeFocused();
    expect(".o_crm_mobile_quick_create .invalid-feedback").toHaveCount(1);
    expect(isSheetExpanded()).toBe(true);
    expectEqualButtonsInView(buttons);
    expect(name).not.toHaveStyle(requiredBorder);
    expect(name).not.toHaveStyle({ boxShadow });
});

// -----------------------------------------------------------------------------
// Activity sheet (CrmMobileLeadActivities)
// -----------------------------------------------------------------------------

/** Domain of the activity-type warm-up: the types usable on leads. */
const LEAD_ACTIVITY_TYPE_DOMAIN = [["res_model", "in", [false, "crm.lead"]]];

/**
 * Records every batch of activity types reaching the framework relational-field
 * cache (`OfflinePlugin.cacheMany2XSearch`), as given.
 */
function trackCachedActivityTypes() {
    const batches = [];
    patchWithCleanup(OfflinePlugin.prototype, {
        cacheMany2XSearch(model, records) {
            if (model === "mail.activity.type") {
                batches.push(records);
            }
            return super.cacheMany2XSearch(...arguments);
        },
    });
    return batches;
}

/** Ids of the activity types in the framework relational-field cache. */
async function cachedActivityTypeIds() {
    const types = await getService(OfflinePlugin).searchMany2XRecords("mail.activity.type", "");
    return (types || []).map(({ id }) => id).sort((a, b) => a - b);
}

/** Selector of the synced activity row of `activityId` in the open sheet. */
function activityRow(activityId) {
    return `.o_crm_mobile_activity_row[data-activity-id='${activityId}']`;
}

test.tags("mobile");
test("mobile activities: types cached on a normal visit", async () => {
    const cachedBatches = trackCachedActivityTypes();
    const warmUps = [];
    onRpc("mail.activity.type", "web_search_read", function warmUp({ kwargs }) {
        const result = this.env["mail.activity.type"].web_search_read(
            kwargs.domain,
            kwargs.specification
        );
        warmUps.push({ domain: kwargs.domain, specification: kwargs.specification, result });
        return result;
    });
    const setOffline = mockOffline();
    const calls = trackCalls();

    // Desktop-size visit: the leads' current types (the `kanban_activity` dependency
    // `activity_type_id`) are cached by the framework, with no added request.
    await resize({ width: 1366, height: 768 });
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(calls.filter((call) => call.startsWith("mail.activity"))).toEqual([]);
    expect(warmUps).toEqual([]);
    expect(await cachedActivityTypeIds()).toEqual([1, CALL_TYPE_ID]);

    // Normal visit at mobile size, without opening the sheet: one warm-up request,
    // whose result's records reach the cache.
    await resize({ width: 375, height: 667 });
    await animationFrame();
    await openAction(ACTION_ID);
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(warmUps).toHaveLength(1);
    expect(warmUps[0].domain).toEqual(LEAD_ACTIVITY_TYPE_DOMAIN);
    expect(warmUps[0].specification).toEqual({ display_name: {} });
    expect(warmUps[0].result.records).toEqual([
        { id: 1, display_name: "Email" },
        { id: CALL_TYPE_ID, display_name: "Call" },
        { id: 28, display_name: "Upload Document" },
    ]);
    expect(cachedBatches.map((batch) => JSON.stringify(batch))).toInclude(
        JSON.stringify(warmUps[0].result.records)
    );
    expect(calls.filter((call) => call === "mail.activity.type/web_search_read")).toHaveLength(1);
    expect(await cachedActivityTypeIds()).toEqual([1, CALL_TYPE_ID, 28]);

    // Offline, the sheet lists them.
    await setOffline(true);
    await openActivities("Office Design");
    expect(".o_crm_mobile_log_call").toBeEnabled();
    await contains(".o_crm_mobile_schedule_followup").click();
    expect(queryAllTexts(".o_crm_mobile_activity_type option").sort()).toEqual([
        "Call",
        "Email",
        "Upload Document",
    ]);
    expect(calls.filter((call) => call.startsWith("mail.activity"))).toHaveLength(1);
});

test.tags("mobile");
test("mobile activities from the lead form after a form-only visit", async () => {
    expect.errors(2);
    const specs = [];
    onRpc("crm.lead", "web_read", ({ kwargs }) => {
        specs.push(kwargs.specification);
    });
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    // Online at mobile size, only the lead form is opened: no pipeline, no sheet.
    const openLeadForm = () =>
        getService("action").doAction(ACTION_ID, {
            clearBreadcrumbs: true,
            viewType: "form",
            props: { resId: 1 },
        });
    await openLeadForm();
    expect(".o_form_view").toHaveCount(1);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(".o_crm_mobile_activities_button").toHaveCount(1);
    expect(specs).toHaveLength(1);
    expect(Object.keys(specs[0].activity_ids.fields)).toEqual(ACTIVITY_SUBFIELDS);

    // Offline, the form is served from its cached load and its "Activities" button
    // opens the sheet with the lead's rows.
    await setOffline(true);
    const calls = trackCalls();
    await openLeadForm();
    expect(".o_form_view").toHaveCount(1);
    expect(".o_crm_mobile_activities_button").toHaveAttribute("data-available-offline");
    await contains(".o_crm_mobile_activities_button").click();
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);

    // A call is logged and a row marked done: both queued, both pending.
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    await contains(`${activityRow(2)} .o_crm_mobile_activity_done`).click();
    expect(
        queued("mail.activity").map(({ method, args }) => [method, args[0][0]?.summary ?? args[0]])
    ).toEqual([
        ["create", "Call"],
        ["action_done", [2]],
    ]);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Call");
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_pending_sync").toHaveText("Pending sync");
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).toHaveText("Done · Pending sync");
    expect(`${activityRow(1)} .o_crm_mobile_activity_done`).toHaveText("Mark done");
    expect(calls.filter((call) => call.startsWith("mail.activity"))).toEqual([]);
    // The framework's own cached loads offline: the form root and its statusbar stages.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.stage/search_read",
    ]);
});

test.tags("mobile");
test("mobile activities: the lead form sheet closes when the screen widens", async () => {
    let controller;
    patchWithCleanup(CrmFormController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    let rootLoads = 0;
    onRpc("crm.lead", "web_read", () => {
        rootLoads++;
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(ACTION_ID, {
        clearBreadcrumbs: true,
        viewType: "form",
        props: { resId: 1 },
    });
    // An unsaved edit, then the phone "Activities" sheet.
    await contains(".o_field_widget[name=name] input").edit("Office Design, edited");
    expect(controller.model.root.dirty).toBe(true);
    await contains(".o_crm_mobile_activities_button").click();
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(document.body).toHaveClass("bottom-sheet-open");
    expect(rootLoads).toBe(1);

    // Widened: the sheet and the button are gone, while the form keeps its record,
    // unsaved edit included (no root reload).
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(document.body).not.toHaveClass("bottom-sheet-open");
    expect(".o_crm_mobile_activities_button").toHaveCount(0);
    expect(".o_form_view").toHaveCount(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design, edited");
    expect(await controller.model.root.isDirty()).toBe(true);
    expect(rootLoads).toBe(1);

    // On the wide screen, a direct call of the opener opens nothing.
    controller.openMobileActivities({ currentTarget: queryFirst(".o_form_view") });
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(document.body).not.toHaveClass("bottom-sheet-open");
});

test.tags("mobile");
test("lead form widened from a phone saves and runs onchanges with the desktop specification", async () => {
    // An edit of the contact runs an onchange, whose result the form shows.
    CrmLead._onChanges = {
        contact_name(record) {
            record.probability = 55;
        },
    };
    const reads = [];
    const onchanges = [];
    const saves = [];
    onRpc("crm.lead", "web_read", ({ kwargs }) => {
        reads.push(kwargs.specification);
    });
    onRpc("crm.lead", "onchange", ({ args }) => {
        onchanges.push(args[3]);
    });
    onRpc("crm.lead", "web_save", ({ kwargs }) => {
        saves.push(kwargs.specification);
    });
    const serverLead = () =>
        MockServer.env["crm.lead"].search_read(
            [["id", "=", 1]],
            ["name", "contact_name", "probability"]
        )[0];
    await mountWithCleanup(WebClient);
    const openLeadForm = () =>
        getService("action").doAction(ACTION_ID, {
            clearBreadcrumbs: true,
            viewType: "form",
            props: { resId: 1 },
        });

    // On the phone, the root load carries the lead's activity rows.
    await openLeadForm();
    expect(reads).toHaveLength(1);
    expect(Object.keys(reads[0].activity_ids.fields)).toEqual(ACTIVITY_SUBFIELDS);

    // An edit without onchange made on the phone, then widened (no reload): the edit
    // is saved with the desktop specification, and so is the next save.
    await contains(".o_field_widget[name=name] input").edit("Office Design, wide");
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design, wide");
    await contains(".o_form_button_save").click();
    expect(reads).toHaveLength(1);
    expect(saves).toHaveLength(1);
    expect(saves[0]).not.toInclude("activity_ids");
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design, wide");
    expect(serverLead().name).toBe("Office Design, wide");
    await contains(".o_field_widget[name=name] input").edit("Office Design, saved twice");
    await contains(".o_form_button_save").click();
    expect(saves).toHaveLength(2);
    expect(saves[1]).toEqual(saves[0]);
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design, saved twice");
    expect(serverLead().name).toBe("Office Design, saved twice");

    // Back on the phone, the next root load has the activity rows again. Widened, an
    // onchange before any save is requested with the desktop specification, and so is
    // the save that follows it.
    await resize({ width: 375, height: 667 });
    await openLeadForm();
    expect(reads).toHaveLength(2);
    expect(Object.keys(reads[1].activity_ids.fields)).toEqual(ACTIVITY_SUBFIELDS);
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    await contains(".o_field_widget[name=contact_name] input").edit("Ann Example");
    expect(onchanges).toHaveLength(1);
    expect(onchanges[0]).not.toInclude("activity_ids");
    expect(".o_field_widget[name=probability] input").toHaveValue("55.00");
    await contains(".o_form_button_save").click();
    expect(saves).toHaveLength(3);
    expect(saves[2]).toEqual(saves[0]);
    expect(".o_field_widget[name=contact_name] input").toHaveValue("Ann Example");
    expect(serverLead()).toEqual({
        id: 1,
        name: "Office Design, saved twice",
        contact_name: "Ann Example",
        probability: 55,
    });

    // The desktop reference: the same form opened at desktop size requests the same.
    await openLeadForm();
    expect(reads).toHaveLength(3);
    expect(reads[2]).not.toInclude("activity_ids");
    expect(saves[0]).toEqual(reads[2]);
    await contains(".o_field_widget[name=contact_name] input").edit("Bob Example");
    expect(onchanges).toHaveLength(2);
    expect(onchanges[1]).toEqual(onchanges[0]);
    await contains(".o_form_button_save").click();
    expect(saves).toHaveLength(4);
    expect(saves[3]).toEqual(saves[0]);
});

test.tags("mobile");
test("new lead form widened from a phone sends the desktop onchange and create", async () => {
    CrmLead._onChanges = {
        contact_name(record) {
            record.probability = 55;
        },
    };
    // Copies of the requests: the mock server completes the values it creates in place.
    const onchanges = [];
    const saves = [];
    onRpc("crm.lead", "onchange", ({ args }) => {
        const [, changes, fieldNames, specification] = structuredClone(args);
        onchanges.push({ changes, fieldNames, specification });
    });
    onRpc("crm.lead", "web_save", ({ args, kwargs }) => {
        const [ids, changes] = structuredClone(args);
        saves.push({ ids, changes, specification: structuredClone(kwargs.specification) });
    });
    await mountWithCleanup(WebClient);
    const openNewLeadForm = () =>
        getService("action").doAction(ACTION_ID, { clearBreadcrumbs: true, viewType: "form" });
    const editAndSave = async () => {
        await contains(".o_field_widget[name=contact_name] input").edit("Ann Example");
        await contains(".o_field_widget[name=name] input").edit("Wide Lead");
        await contains(".o_form_button_save").click();
    };

    // On the phone, the new lead's default values are requested with the activity rows.
    await openNewLeadForm();
    expect(onchanges).toHaveLength(1);
    expect(onchanges[0].fieldNames).toEqual([]);
    expect(Object.keys(onchanges[0].specification.activity_ids.fields)).toEqual(ACTIVITY_SUBFIELDS);

    // Widened (no reload), neither the onchange nor the create sends the activities.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    await editAndSave();
    expect(onchanges).toHaveLength(2);
    expect(saves).toHaveLength(1);
    const [, widenedOnchange] = onchanges;
    const [widenedSave] = saves;
    expect(widenedOnchange.fieldNames).toEqual(["contact_name"]);
    expect(widenedOnchange.specification).not.toInclude("activity_ids");
    expect(widenedOnchange.changes).not.toInclude("activity_ids");
    expect(widenedSave.ids).toEqual([]);
    expect(widenedSave.specification).not.toInclude("activity_ids");
    expect(widenedSave.changes).not.toInclude("activity_ids");
    expect(widenedSave.changes).toInclude("name");
    expect(".o_field_widget[name=name] input").toHaveValue("Wide Lead");
    expect(".o_field_widget[name=probability] input").toHaveValue("55.00");
    const created = MockServer.env["crm.lead"].search_read(
        [["name", "=", "Wide Lead"]],
        ["contact_name", "probability", "type"]
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({
        id: created[0].id,
        contact_name: "Ann Example",
        probability: 55,
        type: "opportunity",
    });

    // The desktop reference: a new lead form opened at desktop size, edited the same way.
    await openNewLeadForm();
    expect(onchanges).toHaveLength(3);
    expect(onchanges[2].specification).toEqual(widenedOnchange.specification);
    await editAndSave();
    expect(onchanges).toHaveLength(4);
    expect(saves).toHaveLength(2);
    expect(onchanges[3]).toEqual(widenedOnchange);
    expect(saves[1]).toEqual(widenedSave);
});

test.tags("mobile");
test("mobile activities: sheet stays open across reconnection", async () => {
    onRpc("mail.activity", "create", ({ args }) => {
        if (args[0][0].summary === "Rejected visit") {
            throw makeServerError({ message: "Invalid activity" });
        }
    });
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await openActivities("Office Design");

    // Offline: a call is logged, a follow-up the server will reject is scheduled,
    // and an activity is marked done.
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    await contains(".o_crm_mobile_schedule_followup").click();
    await contains(".o_crm_mobile_activity_summary").edit("Rejected visit", { confirm: false });
    await contains(".o_crm_mobile_activity_save").click();
    await contains(`${activityRow(2)} .o_crm_mobile_activity_done`).click();
    expect(queryAllTexts(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title")).toEqual([
        "Call",
        "Rejected visit",
    ]);

    await reconnect(setOffline);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    // The done row is gone; the logged call is a synced row with its own done button.
    expect(activityRow(2)).toHaveCount(0);
    const [newActivity] = MockServer.env["mail.activity"].search_read(
        [
            ["res_id", "=", 1],
            ["summary", "=", "Call"],
        ],
        ["activity_type_id"]
    );
    expect(newActivity.activity_type_id[0]).toBe(CALL_TYPE_ID);
    expect(`${activityRow(newActivity.id)} .o_crm_mobile_activity_title`).toHaveText("Call");
    expect(`${activityRow(newActivity.id)} .o_crm_mobile_activity_done`).toHaveText("Mark done");
    expect(`${activityRow(newActivity.id)} .o_crm_mobile_activity_done`).toBeEnabled();
    expect(activityTitles()).toEqual(["Follow-up call", "Call", "Rejected visit"]);
    // The rejected create stays, with "Sync failed".
    expect(".o_crm_mobile_activity_pending").toHaveCount(1);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText(
        "Rejected visit"
    );
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_pending_sync").toHaveText("Sync failed");
    const [parked] = queued("mail.activity");
    expect(parked.method).toBe("create");
    expect(parked.extras.error).toInclude("Invalid activity");
    await contains(`${activityRow(newActivity.id)} .o_crm_mobile_activity_done`).click();
    expect(activityRow(newActivity.id)).toHaveCount(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Rejected visit"]);
});

test.tags("mobile");
test("mobile activities: log a call queues the Call type offline and shows pending", async () => {
    mockDate("2026-10-02 10:00:00");
    const received = receivedCalls("mail.activity", "create");
    // No lead has a salesperson: no user (avatar) reaches the relational-field cache.
    await makeMockServer();
    MockServer.env["crm.lead"].write(MockServer.env["crm.lead"].search([]), { user_id: false });
    const setOffline = mockOffline();
    await mountPipeline();
    expect((await getService(OfflinePlugin).searchMany2XRecords("res.users", "")) || []).toEqual(
        []
    );
    await setOffline(true);
    const calls = trackCalls();
    await openActivities("Office Design");

    await contains(".o_crm_mobile_log_call").click();
    expect(".o_crm_mobile_activity_form").toHaveCount(1);
    // The first type is Email: the form opens on the arch's Call type, by id.
    expect(queryFirst(".o_crm_mobile_activity_type option").textContent).toBe("Email");
    expect(".o_crm_mobile_activity_type").toHaveValue(String(CALL_TYPE_ID));
    expect(".o_crm_mobile_activity_summary").toHaveValue("Call");
    expect(queryFirst(".o_crm_mobile_activity_date").value).toBe("2026-10-02");
    // The session user is the only (and selected) assignee.
    expect(queryAll(".o_crm_mobile_activity_user option").map((option) => option.value)).toEqual([
        String(serverState.userId),
    ]);
    expect(".o_crm_mobile_activity_user").toHaveValue(String(serverState.userId));
    await contains(".o_crm_mobile_activity_save").click();

    const [create] = queued("mail.activity");
    expect(create.method).toBe("create");
    // Queued with the activity's delivery key.
    const key = create.kwargs.context[CRM_OFFLINE_CREATE_KEY];
    expect(key).toMatch(DELIVERY_KEY);
    const createCall = {
        model: "mail.activity",
        method: "create",
        args: [
            [
                {
                    res_model: "crm.lead",
                    res_id: 1,
                    activity_type_id: CALL_TYPE_ID,
                    summary: "Call",
                    date_deadline: "2026-10-02",
                    user_id: serverState.userId,
                },
            ],
        ],
        kwargs: {
            context: {
                ...user.context,
                [CRM_OFFLINE_CREATE_KEY]: key,
                [CRM_OFFLINE_UID_KEY]: user.userId,
            },
        },
    };
    expect(create.args).toEqual(createCall.args);
    // The user context: no default of the lead action becomes an activity default.
    expect(create.kwargs.context.uid).toBe(serverState.userId);
    expect(create.kwargs.context.default_type).toBe(undefined);
    expect(queued("mail.activity").map(ormCall)).toEqual([createCall]);
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Call");
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_type_label").toHaveText("Call");
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_deadline").toHaveText(
        "10/02/2026"
    );
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_pending_sync").toHaveText("Pending sync");
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_done").toHaveCount(0);
    expect(calls).toEqual([]);

    // Replayed: the server receives the queued create once, and no other write.
    await reconnect(setOffline);
    expect(queued("mail.activity")).toEqual([]);
    expect(received).toEqual([createCall]);
    expect(calls.filter((call) => WRITE_CALL.test(call))).toEqual(["mail.activity/create"]);
});

/** The empty-state line of the open activity sheet. */
const EMPTY_ACTIVITIES = ".o_crm_mobile_lead_activities_sheet .o_crm_mobile_activities_empty";

test.tags("mobile");
test("mobile activities: the sheet of a lead without activities says so until a call is logged", async () => {
    mockDate("2026-10-02 10:00:00");
    const setOffline = mockOffline();
    await mountPipeline();

    // A lead with activities lists them, without the line.
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);
    expect(EMPTY_ACTIVITIES).toHaveCount(0);
    await closeSheet();

    // A lead without activities says so, and scheduling stays available.
    await openActivities("Quote for Chairs");
    expect(".o_crm_mobile_activity_row").toHaveCount(0);
    expect(EMPTY_ACTIVITIES).toHaveCount(1);
    expect(EMPTY_ACTIVITIES).toHaveText("No activities");
    expect(EMPTY_ACTIVITIES).toHaveStyle({ color: EMPTY_STATE_COLOR });
    expect(".o_crm_mobile_activities_notice").toHaveCount(0);
    expect(".o_crm_mobile_log_call").toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").toBeEnabled();

    // Offline, the logged call is listed as pending: the line leaves at once.
    await setOffline(true);
    await contains(".o_crm_mobile_log_call").click();
    expect(EMPTY_ACTIVITIES).toHaveCount(1);
    await contains(".o_crm_mobile_activity_save").click();
    expect(queued("mail.activity").map(({ method }) => method)).toEqual(["create"]);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Call");
    expect(EMPTY_ACTIVITIES).toHaveCount(0);

    // Replayed, the call is a synced row of the still-open sheet: still no line.
    await reconnect(setOffline);
    expect(queued("mail.activity")).toEqual([]);
    expect(activityTitles()).toEqual(["Call"]);
    expect(".o_crm_mobile_activity_pending").toHaveCount(0);
    expect(EMPTY_ACTIVITIES).toHaveCount(0);
});

test.tags("mobile");
test("mobile activities: a lead without activity data shows the after-sync notice and no empty-state line", async () => {
    expect.errors(1);
    const setOffline = mockOffline();
    // Visited online at desktop size: the arch's own variant, without activities.
    await resize({ width: 1366, height: 768 });
    await mountPipeline({ arch: plainPipelineArch });
    // Offline on a phone, the desktop variant is served from the cache: the sheet
    // knows nothing of the lead's activities, so it does not say it has none.
    await setOffline(true);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    await openActivities("Quote for Chairs");
    expect(".o_crm_mobile_activity_row").toHaveCount(0);
    expect(".o_crm_mobile_activities_notice").toHaveText("Activities load after sync");
    expect(EMPTY_ACTIVITIES).toHaveCount(0);
    // Only the framework's offline root load of the never-cached mobile variant.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

test.tags("mobile");
test("mobile activities: schedule follow-up queues offline and shows pending", async () => {
    mockDate("2026-10-02 10:00:00");
    const received = receivedCalls("mail.activity", "create");
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    const calls = trackCalls();
    await contains(".o_crm_mobile_pipeline_next").click();
    await openActivities("Conference Room");
    expect(activityTitles()).toEqual(["Send the quote"]);

    // Cancel closes the form without scheduling.
    await contains(".o_crm_mobile_schedule_followup").click();
    await contains(".o_crm_mobile_activity_cancel").click();
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(queued("mail.activity")).toEqual([]);

    // The follow-up form opens on the first cached type, due tomorrow.
    await contains(".o_crm_mobile_schedule_followup").click();
    expect(".o_crm_mobile_activity_type").toHaveValue("1");
    expect(".o_crm_mobile_activity_summary").toHaveValue("");
    expect(queryFirst(".o_crm_mobile_activity_date").value).toBe("2026-10-03");
    expect(".o_crm_mobile_activity_user").toHaveValue(String(serverState.userId));
    await contains(".o_crm_mobile_activity_type").select("28");
    await contains(".o_crm_mobile_activity_summary").edit("Send the contract", {
        confirm: false,
    });
    await contains(".o_crm_mobile_activity_save").click();

    const [create] = queued("mail.activity");
    expect(create.method).toBe("create");
    const followUpValues = {
        res_model: "crm.lead",
        res_id: 4,
        activity_type_id: 28,
        summary: "Send the contract",
        date_deadline: "2026-10-03",
        user_id: serverState.userId,
    };
    expect(create.args[0][0]).toEqual(followUpValues);
    const key = create.kwargs.context[CRM_OFFLINE_CREATE_KEY];
    expect(key).toMatch(DELIVERY_KEY);
    // The user context and the activity's delivery key only: no key of the lead
    // action becomes an activity default.
    const createCall = {
        model: "mail.activity",
        method: "create",
        args: [[followUpValues]],
        kwargs: {
            context: {
                ...user.context,
                [CRM_OFFLINE_CREATE_KEY]: key,
                [CRM_OFFLINE_UID_KEY]: user.userId,
            },
        },
    };
    expect(queued("mail.activity").map(ormCall)).toEqual([createCall]);
    const pending = ".o_crm_mobile_activity_pending";
    expect(`${pending} .o_crm_mobile_activity_title`).toHaveText("Send the contract");
    expect(`${pending} .o_crm_mobile_activity_type_label`).toHaveText("Upload Document");
    expect(`${pending} .o_crm_mobile_activity_deadline`).toHaveText("10/03/2026");
    expect(`${pending} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");

    // Read from the queue: still listed when the sheet is opened again.
    await closeSheet();
    await openActivities("Conference Room");
    expect(activityTitles()).toEqual(["Send the quote", "Send the contract"]);
    expect(calls).toEqual([]);

    // Replayed: the server receives the queued create once, and no other write.
    await reconnect(setOffline);
    expect(queued("mail.activity")).toEqual([]);
    expect(received).toEqual([createCall]);
    expect(calls.filter((call) => WRITE_CALL.test(call))).toEqual(["mail.activity/create"]);
});

test.tags("mobile");
test("mobile activities: a follow-up without summary queues summary false and shows its type", async () => {
    mockDate("2026-10-02 10:00:00");
    const received = receivedCalls("mail.activity", "create");
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await contains(".o_crm_mobile_pipeline_next").click();
    await openActivities("Conference Room");
    expect(activityTitles()).toEqual(["Send the quote"]);

    // A summary of blanks only is no summary: sent as false, as the form view sends
    // an empty char field.
    await contains(".o_crm_mobile_schedule_followup").click();
    await contains(".o_crm_mobile_activity_summary").edit("   ", { confirm: false });
    await contains(".o_crm_mobile_activity_save").click();
    const followUpValues = {
        res_model: "crm.lead",
        res_id: 4,
        activity_type_id: 1,
        summary: false,
        date_deadline: "2026-10-03",
        user_id: serverState.userId,
    };
    expect(queued("mail.activity").map(({ args }) => args)).toEqual([[[followUpValues]]]);
    // The pending row is titled by its type.
    const pending = ".o_crm_mobile_activity_pending";
    expect(`${pending} .o_crm_mobile_activity_title`).toHaveText("Email");
    expect(`${pending} .o_crm_mobile_activity_type_label`).toHaveText("Email");
    expect(activityTitles()).toEqual(["Send the quote", "Email"]);

    // Replayed as queued: the synced activity has no summary and is titled by its type.
    await reconnect(setOffline);
    expect(queued("mail.activity")).toEqual([]);
    expect(received.map(({ args }) => args)).toEqual([[[followUpValues]]]);
    const leadActivities = [
        ["res_model", "=", "crm.lead"],
        ["res_id", "=", 4],
    ];
    expect(MockServer.env["mail.activity"].search_read(leadActivities, ["summary"])).toEqual([
        { id: 3, summary: "Send the quote" },
        { id: 4, summary: false },
    ]);
    expect(pending).toHaveCount(0);
    expect(activityTitles()).toEqual(["Send the quote", "Email"]);
});

test.tags("mobile");
test("mobile activities: mark done queues action_done offline and the list updates after replay", async () => {
    // Runs before the module's `action_done` handler, which still removes the activity.
    const received = receivedCalls("mail.activity", "action_done");
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    const calls = trackCalls();
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);

    await contains(`${activityRow(1)} .o_crm_mobile_activity_done`).click();
    expect(`${activityRow(1)}`).toHaveClass("o_crm_mobile_activity_done_pending");
    expect(`${activityRow(1)} .o_crm_mobile_activity_done`).toHaveText("Done · Pending sync");
    expect(`${activityRow(1)} .o_crm_mobile_activity_done`).not.toBeEnabled();
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).toBeEnabled();
    const [done] = queued("mail.activity");
    expect(done.method).toBe("action_done");
    expect(done.args).toEqual([[1]]);
    expect(done.kwargs.context.uid).toBe(serverState.userId);
    // The user context only: no key of the lead action reaches the activity call.
    const doneCall = {
        model: "mail.activity",
        method: "action_done",
        args: [[1]],
        kwargs: { context: { ...user.context, [CRM_OFFLINE_UID_KEY]: user.userId } },
    };
    expect(queued("mail.activity").map(ormCall)).toEqual([doneCall]);
    expect(calls).toEqual([]);

    // After the replay, the done activity has left the list (sheet still open).
    await reconnect(setOffline);
    expect(queued("mail.activity")).toEqual([]);
    expect(MockServer.env["mail.activity"].search_read([["id", "=", 1]], ["id"])).toEqual([]);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityTitles()).toEqual(["Send brochure"]);
    expect(activityRow(1)).toHaveCount(0);
    // The server received the queued call once, and no other write.
    expect(received).toEqual([doneCall]);
    expect(calls.filter((call) => WRITE_CALL.test(call))).toEqual(["mail.activity/action_done"]);
});

test.tags("mobile");
test("mobile activities: controls disabled without cached types", async () => {
    // The activities have no type, so no lead has a next activity type (the related
    // `activity_type_id` the `kanban_activity` dependency caches), and the Call type
    // is set up for another model (left out of the warm-up).
    mailModels.MailActivity._records = ACTIVITY_RECORDS.map((record) => ({
        ...record,
        activity_type_id: false,
    }));
    mailModels.MailActivityType._records = mailModels.MailActivityType._records.map((type) =>
        type.id === CALL_TYPE_ID ? { ...type, res_model: "res.partner" } : type
    );
    // The warm-up answers once released.
    const warmUp = Promise.withResolvers();
    onRpc("mail.activity.type", "web_search_read", () => warmUp.promise);
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);

    // No cached type: both openers are disabled; the rows and "Mark done" stay usable.
    expect(await cachedActivityTypeIds()).toEqual([]);
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").not.toBeEnabled();
    expect(".o_crm_mobile_log_call").toHaveAttribute("data-available-offline");
    expect(`${activityRow(1)} .o_crm_mobile_activity_done`).toBeEnabled();
    // A neutral notice gives the reason, and both disabled openers reference it.
    expect(".o_crm_mobile_activity_types_notice").toHaveText("Activity types load after sync");
    expect(".o_crm_mobile_activity_types_notice").toHaveAttribute("role", "status");
    expect(".o_crm_mobile_activity_types_notice").not.toHaveClass("text-danger");
    expect(".o_crm_mobile_activity_types_notice").not.toHaveClass("invalid-feedback");
    const noTypesNoticeId = queryFirst(".o_crm_mobile_activity_types_notice").id;
    expect(noTypesNoticeId).toMatch(/_types_notice$/);
    expect(".o_crm_mobile_log_call").toHaveAttribute("aria-describedby", noTypesNoticeId);
    expect(".o_crm_mobile_schedule_followup").toHaveAttribute("aria-describedby", noTypesNoticeId);
    await closeSheet();

    // Cached types without the Call type: scheduling works, "Log a call" does not.
    // The warm-up's answer also tells the framework that the connection is back.
    warmUp.resolve();
    await animationFrame();
    expect(await cachedActivityTypeIds()).toEqual([1, 28]);
    await openActivities("Office Design");
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").toBeEnabled();
    // The notice now explains "Log a call" alone: online, the server offers no Call
    // type for leads; offline, it may come with the next sync.
    expect(".o_crm_mobile_activity_types_notice").toHaveText(
        "The Call activity type is not available"
    );
    const callNoticeId = queryFirst(".o_crm_mobile_activity_types_notice").id;
    expect(".o_crm_mobile_log_call").toHaveAttribute("aria-describedby", callNoticeId);
    expect(".o_crm_mobile_schedule_followup").not.toHaveAttribute("aria-describedby");
    await setOffline(true);
    expect(".o_crm_mobile_activity_types_notice").toHaveText(
        "The Call activity type loads after sync"
    );
    expect(".o_crm_mobile_log_call").toHaveAttribute("aria-describedby", callNoticeId);
    await contains(".o_crm_mobile_schedule_followup").click();
    expect(queryAllTexts(".o_crm_mobile_activity_type option")).toEqual([
        "Email",
        "Upload Document",
    ]);
    // The open form has no disabled opener to explain.
    expect(".o_crm_mobile_activity_types_notice").toHaveCount(0);
    expect(queued("mail.activity")).toEqual([]);
});

test.tags("mobile");
test("mobile activities: types are offered in the warm-up's order, the follow-up on the first", async () => {
    // The server orders the types by sequence (here Upload Document, Email, Call),
    // while the relational-field cache keeps them by id.
    const sequenceOrder = [28, 1, CALL_TYPE_ID];
    onRpc("mail.activity.type", "web_search_read", function warmUp({ kwargs }) {
        const result = this.env["mail.activity.type"].web_search_read(
            kwargs.domain,
            kwargs.specification
        );
        result.records.sort((a, b) => sequenceOrder.indexOf(a.id) - sequenceOrder.indexOf(b.id));
        return result;
    });
    const setOffline = mockOffline();
    const calls = trackCalls();
    await mountPipeline();
    await animationFrame();
    expect(calls.filter((call) => call.startsWith("mail.activity"))).toEqual([
        "mail.activity.type/web_search_read",
    ]);
    expect(await cachedActivityTypeIds()).toEqual([1, CALL_TYPE_ID, 28]);

    // Online, then offline: the follow-up opens on the first type in sequence, and
    // the options follow the sequence; "Log a call" still opens on Call.
    for (const offline of [false, true]) {
        if (offline) {
            await setOffline(true);
        }
        await openActivities("Office Design");
        await contains(".o_crm_mobile_schedule_followup").click();
        expect(queryAllTexts(".o_crm_mobile_activity_type option")).toEqual([
            "Upload Document",
            "Email",
            "Call",
        ]);
        expect(".o_crm_mobile_activity_type").toHaveValue("28");
        await contains(".o_crm_mobile_activity_cancel").click();
        await contains(".o_crm_mobile_log_call").click();
        expect(".o_crm_mobile_activity_type").toHaveValue(String(CALL_TYPE_ID));
        await contains(".o_crm_mobile_activity_cancel").click();
        await closeSheet();
    }
    // The sheet read the types from the cache: the warm-up is the only type request.
    expect(calls.filter((call) => call.startsWith("mail.activity"))).toEqual([
        "mail.activity.type/web_search_read",
    ]);
});

test.tags("mobile");
test("mobile activities: a cached type the warm-up leaves out is not offered", async () => {
    // Call is archived, but a lead's next activity is still a call: the root load
    // caches Call as that lead's next activity type, and the warm-up reads only the
    // active types.
    mailModels.MailActivityType._records = mailModels.MailActivityType._records.map((type) =>
        type.id === CALL_TYPE_ID ? { ...type, active: false } : type
    );
    const warmUps = [];
    onRpc("mail.activity.type", "web_search_read", function warmUp({ kwargs }) {
        const result = this.env["mail.activity.type"].web_search_read(
            kwargs.domain,
            kwargs.specification
        );
        warmUps.push(result.records.map(({ id }) => id));
        return result;
    });
    const setOffline = mockOffline();
    await mountPipeline();
    await animationFrame();
    expect(warmUps).toEqual([[1, 28]]);
    expect(await cachedActivityTypeIds()).toEqual([1, CALL_TYPE_ID, 28]);

    // Online, then offline: "Log a call" is disabled and the follow-up does not
    // offer Call; the synced call activity still shows its type.
    for (const offline of [false, true]) {
        if (offline) {
            await setOffline(true);
        }
        await openActivities("Office Design");
        expect(`${activityRow(1)} .o_crm_mobile_activity_type_label`).toHaveText("Call");
        expect(".o_crm_mobile_log_call").not.toBeEnabled();
        expect(".o_crm_mobile_schedule_followup").toBeEnabled();
        expect(".o_crm_mobile_activity_types_notice").toHaveText(
            offline
                ? "The Call activity type loads after sync"
                : "The Call activity type is not available"
        );
        expect(".o_crm_mobile_log_call").toHaveAttribute(
            "aria-describedby",
            queryFirst(".o_crm_mobile_activity_types_notice").id
        );
        await contains(".o_crm_mobile_schedule_followup").click();
        expect(queryAllTexts(".o_crm_mobile_activity_type option")).toEqual([
            "Email",
            "Upload Document",
        ]);
        expect(".o_crm_mobile_activity_type").toHaveValue("1");
        await contains(".o_crm_mobile_activity_cancel").click();
        await closeSheet();
    }
    expect(queued("mail.activity")).toEqual([]);
});

test.tags("mobile");
test("mobile activities: without relational-field cache, the types are read from the server online", async () => {
    // A non-secure context (or a session without cache secret): the framework
    // relational-field cache answers nothing.
    patchWithCleanup(OfflinePlugin.prototype, {
        async searchMany2XRecords(model) {
            if (model === "mail.activity.type") {
                return undefined;
            }
            return super.searchMany2XRecords(...arguments);
        },
    });
    let failTypeRead = false;
    // Once set, a type read answers when it is resolved.
    let heldTypeRead = null;
    onRpc("mail.activity.type", "web_search_read", () => {
        if (failTypeRead) {
            throw makeServerError({ message: "Temporarily unavailable" });
        }
        return heldTypeRead?.promise;
    });
    const received = receivedCalls("mail.activity", "create");
    const setOffline = mockOffline();
    await mountPipeline();
    await animationFrame();
    const calls = trackCalls();
    const typeReads = () => calls.filter((call) => call === "mail.activity.type/web_search_read");

    // Online: the sheet reads the types as the warm-up does, in the server's order,
    // and schedules with them.
    await openActivities("Office Design");
    expect(typeReads()).toHaveLength(1);
    expect(".o_crm_mobile_log_call").toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").toBeEnabled();
    expect(".o_crm_mobile_activity_types_notice").toHaveCount(0);
    expect(".o_crm_mobile_log_call").not.toHaveAttribute("aria-describedby");
    expect(".o_crm_mobile_schedule_followup").not.toHaveAttribute("aria-describedby");
    await contains(".o_crm_mobile_schedule_followup").click();
    expect(queryAllTexts(".o_crm_mobile_activity_type option")).toEqual([
        "Email",
        "Call",
        "Upload Document",
    ]);
    await contains(".o_crm_mobile_activity_cancel").click();
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    await animationFrame();
    expect(received.map(({ args }) => args[0][0].activity_type_id)).toEqual([CALL_TYPE_ID]);
    expect(queued("mail.activity")).toEqual([]);

    // The connection drops while the sheet stays open: the types read online are not
    // available offline, so both openers turn disabled with the reason, and no type
    // is requested.
    expect(".o_crm_mobile_log_call").toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").toBeEnabled();
    await setOffline(true);
    await animationFrame();
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").not.toBeEnabled();
    expect(".o_crm_mobile_activity_types_notice").toHaveText("Activity types load after sync");
    const droppedNoticeId = queryFirst(".o_crm_mobile_activity_types_notice").id;
    expect(".o_crm_mobile_log_call").toHaveAttribute("aria-describedby", droppedNoticeId);
    expect(".o_crm_mobile_schedule_followup").toHaveAttribute("aria-describedby", droppedNoticeId);
    expect(typeReads()).toHaveLength(1);

    // Reconnected: the still-open sheet reads the types again and enables both.
    await reconnect(setOffline);
    expect(typeReads()).toHaveLength(2);
    expect(".o_crm_mobile_log_call").toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").toBeEnabled();
    expect(".o_crm_mobile_activity_types_notice").toHaveCount(0);
    expect(".o_crm_mobile_log_call").not.toHaveAttribute("aria-describedby");
    expect(".o_crm_mobile_schedule_followup").not.toHaveAttribute("aria-describedby");
    await closeSheet();

    // Offline: no type can be read, both openers are disabled and nothing is requested.
    await setOffline(true);
    await openActivities("Office Design");
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").not.toBeEnabled();
    expect(".o_crm_mobile_activity_types_notice").toHaveText("Activity types load after sync");
    expect(typeReads()).toHaveLength(2);

    // Reconnected with the sheet open: until its reread of the types is applied, the
    // sheet keeps the reason of the offline read, never the online one; once applied,
    // both openers are enabled.
    const noticeTexts = new Set([queryFirst(".o_crm_mobile_activity_types_notice").textContent]);
    const observer = new MutationObserver(() => {
        for (const notice of document.querySelectorAll(".o_crm_mobile_activity_types_notice")) {
            noticeTexts.add(notice.textContent);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    after(() => observer.disconnect());
    heldTypeRead = Promise.withResolvers();
    await reconnect(setOffline);
    expect(typeReads()).toHaveLength(3);
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").not.toBeEnabled();
    expect(".o_crm_mobile_activity_types_notice").toHaveText("Activity types load after sync");
    expect(".o_crm_mobile_log_call").toHaveAttribute(
        "aria-describedby",
        queryFirst(".o_crm_mobile_activity_types_notice").id
    );
    heldTypeRead.resolve();
    heldTypeRead = null;
    await animationFrame();
    observer.disconnect();
    expect([...noticeTexts]).toEqual(["Activity types load after sync"]);
    expect(".o_crm_mobile_log_call").toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").toBeEnabled();
    expect(".o_crm_mobile_activity_types_notice").toHaveCount(0);
    expect(".o_crm_mobile_log_call").not.toHaveAttribute("aria-describedby");
    expect(".o_crm_mobile_schedule_followup").not.toHaveAttribute("aria-describedby");
    await closeSheet();

    // A failed online read offers no type, silently, and the notice says so.
    failTypeRead = true;
    await openActivities("Office Design");
    expect(typeReads()).toHaveLength(4);
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").not.toBeEnabled();
    expect(".o_crm_mobile_activity_types_notice").toHaveText("No activity type is available");
    const noticeId = queryFirst(".o_crm_mobile_activity_types_notice").id;
    expect(".o_crm_mobile_log_call").toHaveAttribute("aria-describedby", noticeId);
    expect(".o_crm_mobile_schedule_followup").toHaveAttribute("aria-describedby", noticeId);
});

test.tags("mobile");
test("mobile activities: an open form keeps its type options when the cached types reread empty", async () => {
    mockDate("2026-10-02 10:00:00");
    // Once set, the cache reads (search, and read by id of the warmed types the
    // search did not return) return only the activity types of these ids.
    let readableTypeIds = null;
    const readableTypes = (model, records) =>
        model !== "mail.activity.type" || !readableTypeIds
            ? records
            : (records || []).filter(({ id }) => readableTypeIds.includes(id));
    patchWithCleanup(OfflinePlugin.prototype, {
        async searchMany2XRecords(model) {
            return readableTypes(model, await super.searchMany2XRecords(...arguments));
        },
        async readMany2XRecords(model) {
            return readableTypes(model, await super.readMany2XRecords(...arguments));
        },
    });
    const optionReads = [];
    patchWithCleanup(CrmMobileLeadActivities.prototype, {
        loadOptions() {
            const read = super.loadOptions(...arguments);
            optionReads.push(read);
            return read;
        },
    });
    const received = receivedCalls("mail.activity", "create");
    const setOffline = mockOffline();
    const calls = trackCalls();
    /** Reconnects, then waits for the one options reread of the open sheet it causes. */
    const reconnectAndReread = async () => {
        const reads = optionReads.length;
        await reconnect(setOffline);
        expect(optionReads).toHaveLength(reads + 1);
        await optionReads.at(-1);
        await animationFrame();
    };
    /** Disconnects, then waits for the one options reread of the open sheet it causes. */
    const disconnectAndReread = async () => {
        const reads = optionReads.length;
        await setOffline(true);
        expect(optionReads).toHaveLength(reads + 1);
        await optionReads.at(-1);
        await animationFrame();
    };
    // Option counts of every type select displayed, read at each DOM change.
    const typeOptionCounts = new Set();
    const observer = new MutationObserver(() => {
        for (const select of document.querySelectorAll("select.o_crm_mobile_activity_type")) {
            typeOptionCounts.add(select.options.length);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    after(() => observer.disconnect());
    await mountPipeline();
    await setOffline(true);
    await openActivities("Office Design");
    expect(optionReads).toHaveLength(1);
    await contains(".o_crm_mobile_schedule_followup").click();
    await contains(".o_crm_mobile_activity_type").select("28");
    await contains(".o_crm_mobile_activity_summary").edit("Send the contract", {
        confirm: false,
    });

    // The reread at reconnection finds no type: the open form keeps the options it
    // was opened with, its choice and its draft.
    readableTypeIds = [];
    await reconnectAndReread();
    expect(await cachedActivityTypeIds()).toEqual([]);
    expect(queryAllTexts(".o_crm_mobile_activity_type option").sort()).toEqual([
        "Call",
        "Email",
        "Upload Document",
    ]);
    expect(".o_crm_mobile_activity_type").toHaveValue("28");
    expect(".o_crm_mobile_activity_summary").toHaveValue("Send the contract");

    // Save sends the type shown. The closed form leaves the empty read: both
    // openers are disabled.
    await contains(".o_crm_mobile_activity_save").click();
    await animationFrame();
    const followUpValues = {
        res_model: "crm.lead",
        res_id: 1,
        activity_type_id: 28,
        summary: "Send the contract",
        date_deadline: "2026-10-03",
        user_id: serverState.userId,
    };
    // Sent online with the user context and the activity's delivery key.
    const key = received[0]?.kwargs.context[CRM_OFFLINE_CREATE_KEY];
    expect(key).toMatch(DELIVERY_KEY);
    expect(received).toEqual([
        {
            model: "mail.activity",
            method: "create",
            args: [[followUpValues]],
            kwargs: { context: { ...user.context, [CRM_OFFLINE_CREATE_KEY]: key } },
        },
    ]);
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").not.toBeEnabled();

    // The reread at the disconnection still finds no type; Email and Call read at
    // the next reconnection enable the openers again.
    await disconnectAndReread();
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").not.toBeEnabled();
    readableTypeIds = [1, CALL_TYPE_ID];
    await reconnectAndReread();
    expect(".o_crm_mobile_schedule_followup").toBeEnabled();
    await contains(".o_crm_mobile_schedule_followup").click();
    await contains(".o_crm_mobile_activity_type").select(String(CALL_TYPE_ID));
    await contains(".o_crm_mobile_activity_summary").edit("Book the visit", {
        confirm: false,
    });

    // A reread without the chosen type shows the types read, and Save refuses the
    // type no longer offered: the draft stays, the type is flagged, nothing is sent.
    readableTypeIds = [1, 28];
    await disconnectAndReread();
    await reconnectAndReread();
    expect(queryAllTexts(".o_crm_mobile_activity_type option").sort()).toEqual([
        "Email",
        "Upload Document",
    ]);
    await contains(".o_crm_mobile_activity_save").click();
    expect(".o_crm_mobile_activity_form").toHaveCount(1);
    expect(".o_crm_mobile_activity_summary").toHaveValue("Book the visit");
    expect(".o_crm_mobile_activity_type").toHaveClass("is-invalid");
    expect(".o_crm_mobile_activity_form .invalid-feedback").toHaveText(
        "An activity type is required."
    );
    expect(received).toHaveLength(1);

    await contains(".o_crm_mobile_activity_type").select("28");
    await contains(".o_crm_mobile_activity_save").click();
    await animationFrame();
    expect(received.map(({ args }) => args[0][0])).toEqual([
        followUpValues,
        { ...followUpValues, summary: "Book the visit" },
    ]);
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(queued("mail.activity")).toEqual([]);
    expect(calls.filter((call) => WRITE_CALL.test(call))).toEqual([
        "mail.activity/create",
        "mail.activity/create",
    ]);
    observer.disconnect();
    expect([...typeOptionCounts].sort()).toEqual([2, 3]);
});

test.tags("mobile");
test("mobile activities online: actions reach the server and reload the lead", async () => {
    expect.errors(2);
    mockDate("2026-10-02 10:00:00");
    onRpc("mail.activity", "create", ({ args }) => {
        if (args[0][0].summary === "Rejected visit") {
            throw makeServerError({ message: "Invalid activity" });
        }
    });
    let failLeadReload = false;
    onRpc("crm.lead", "web_read", () => {
        if (failLeadReload) {
            failLeadReload = false;
            throw makeServerError({ message: "Lead reload failed" });
        }
    });
    const calls = trackCalls();
    await mountPipeline();
    await openActivities("Office Design");

    // A call logged online is created on the server, and the reloaded lead lists it
    // as a synced row.
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    await animationFrame();
    expect(calls.filter((call) => call.startsWith("mail.activity/"))).toEqual([
        "mail.activity/create",
    ]);
    expect(queued("mail.activity")).toEqual([]);
    const [created] = MockServer.env["mail.activity"].search_read(
        [
            ["res_id", "=", 1],
            ["summary", "=", "Call"],
        ],
        ["activity_type_id", "date_deadline"]
    );
    expect(created.activity_type_id[0]).toBe(CALL_TYPE_ID);
    expect(created.date_deadline).toBe("2026-10-02");
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(".o_crm_mobile_activity_pending").toHaveCount(0);
    expect(`${activityRow(created.id)} .o_crm_mobile_activity_title`).toHaveText("Call");

    // A server error keeps the form open with its values; nothing is queued.
    await contains(".o_crm_mobile_schedule_followup").click();
    await contains(".o_crm_mobile_activity_summary").edit("Rejected visit", { confirm: false });
    await contains(".o_crm_mobile_activity_save").click();
    await animationFrame();
    expect(".o_crm_mobile_activity_form").toHaveCount(1);
    expect(".o_crm_mobile_activity_summary").toHaveValue("Rejected visit");
    expect(".o_crm_mobile_activity_save").toBeEnabled();
    expect(queued("mail.activity")).toEqual([]);
    expect.verifyErrors(["Invalid activity"]);
    await contains(".o_crm_mobile_activity_cancel").click();

    // Marked done online: removed on the server and from the reloaded rows.
    await contains(`${activityRow(created.id)} .o_crm_mobile_activity_done`).click();
    await animationFrame();
    expect(MockServer.env["mail.activity"].search_count([["id", "=", created.id]])).toBe(0);
    expect(activityRow(created.id)).toHaveCount(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);
    expect(queued("mail.activity")).toEqual([]);

    // A server error on the lead reload after an online write is not a lost
    // connection: it is reported once, the write stands, nothing is queued, and the
    // submitted form closes, so it cannot create the activity a second time, while
    // the sheet stays open.
    failLeadReload = true;
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    await animationFrame();
    expect(failLeadReload).toBe(false);
    expect(
        MockServer.env["mail.activity"].search_count([
            ["res_id", "=", 1],
            ["summary", "=", "Call"],
        ])
    ).toBe(1);
    expect(calls.filter((call) => call === "mail.activity/create")).toHaveLength(3);
    expect(queued("mail.activity")).toEqual([]);
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect.verifyErrors(["Lead reload failed"]);
});

test.tags("mobile");
test("mobile activities online: a failed lead reload after Mark done is reported once and sends no second action_done", async () => {
    expect.errors(1);
    let failLeadReload = false;
    onRpc("crm.lead", "web_read", () => {
        if (failLeadReload) {
            failLeadReload = false;
            throw makeServerError({ message: "Lead reload failed" });
        }
    });
    const calls = trackCalls();
    await mountPipeline();
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);

    // Done on the server, then the lead reload is refused: "Mark done" resolves, the
    // error is reported once, nothing is queued, and the row leaves the list as the
    // reload would have shown it, while the sheet stays open.
    failLeadReload = true;
    const button = queryFirst(`${activityRow(1)} .o_crm_mobile_activity_done`);
    button.click();
    await animationFrame();
    expect(failLeadReload).toBe(false);
    expect(MockServer.env["mail.activity"].search_count([["id", "=", 1]])).toBe(0);
    expect(queued("mail.activity")).toEqual([]);
    expect.verifyErrors(["Lead reload failed"]);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityRow(1)).toHaveCount(0);
    expect(activityTitles()).toEqual(["Send brochure"]);
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).toBeEnabled();

    // The button of the row's last render activated again sends nothing.
    button.click();
    await animationFrame();
    expect(calls.filter((call) => call === "mail.activity/action_done")).toHaveLength(1);
    expect(queued("mail.activity")).toEqual([]);

    // The other activity is still marked done online, and the lead reloads.
    await contains(`${activityRow(2)} .o_crm_mobile_activity_done`).click();
    await animationFrame();
    expect(MockServer.env["mail.activity"].search_count([["id", "=", 2]])).toBe(0);
    expect(activityTitles()).toEqual([]);
    expect(calls.filter((call) => call === "mail.activity/action_done")).toHaveLength(2);
    expect.verifyErrors([]);
});

test.tags("mobile");
test("mobile activities: a dropped connection queues an online action and keeps the lead", async () => {
    const setOffline = mockOffline();
    const drops = dropConnections();
    await mountPipeline();
    await openActivities("Office Design");

    // The connection drops while "Mark done" is sent: the call is queued instead.
    drops.add("mail.activity/action_done");
    await contains(`${activityRow(2)} .o_crm_mobile_activity_done`).click();
    await animationFrame();
    expect(drops.size).toBe(0);
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    const [done] = queued("mail.activity");
    expect(done.method).toBe("action_done");
    expect(done.args).toEqual([[2]]);
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).toHaveText("Done · Pending sync");

    await reconnect(setOffline);
    expect(queued("mail.activity")).toEqual([]);
    expect(MockServer.env["mail.activity"].search_count([["id", "=", 2]])).toBe(0);
    expect(activityRow(2)).toHaveCount(0);

    // Marked done online while the lead reload drops: the server write stands,
    // nothing is queued, the loaded lead is kept and no error is raised.
    drops.add("crm.lead/web_read");
    await contains(`${activityRow(1)} .o_crm_mobile_activity_done`).click();
    await animationFrame();
    expect(drops.size).toBe(0);
    expect(MockServer.env["mail.activity"].search_count([["id", "=", 1]])).toBe(0);
    expect(queued("mail.activity")).toEqual([]);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
});

test.tags("mobile");
test("mobile activities: a failed type warm-up is retried at the next visit", async () => {
    const warmUps = [];
    onRpc("mail.activity.type", "web_search_read", () => {
        warmUps.push(warmUps.length + 1);
        if (warmUps.length === 1) {
            throw makeServerError({ message: "Temporarily unavailable" });
        }
    });
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await animationFrame();
    // The failure is silent: only the leads' current types are cached.
    expect(warmUps).toEqual([1]);
    expect(await cachedActivityTypeIds()).toEqual([1, CALL_TYPE_ID]);

    // The next visit warms the types again, then no more in this session.
    await openAction(LEADS_ACTION_ID);
    await animationFrame();
    expect(warmUps).toEqual([1, 2]);
    expect(await cachedActivityTypeIds()).toEqual([1, CALL_TYPE_ID, 28]);
    await openAction(ACTION_ID);
    await animationFrame();
    expect(warmUps).toEqual([1, 2]);
});

test.tags("mobile");
test("mobile activities: follow-up assignees list the cached salespeople after the session user", async () => {
    await makeMockServer();
    const partnerId = MockServer.env["res.partner"].create({ name: "Marc Demo" });
    const salespersonId = MockServer.env["res.users"].create({
        name: "Marc Demo",
        partner_id: partnerId,
    });
    MockServer.env["crm.lead"].write([4], { user_id: salespersonId });
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await openActivities("Office Design");

    // The session user first, then the other cached salespeople, each once.
    await contains(".o_crm_mobile_schedule_followup").click();
    expect(
        queryAll(".o_crm_mobile_activity_user option").map((option) => Number(option.value))
    ).toEqual([serverState.userId, salespersonId]);
    expect(queryAllTexts(".o_crm_mobile_activity_user option")).toEqual([
        "Mitchell Admin",
        "Marc Demo",
    ]);
    await contains(".o_crm_mobile_activity_user").select(String(salespersonId));
    await contains(".o_crm_mobile_activity_summary").edit("Visit", { confirm: false });
    await contains(".o_crm_mobile_activity_save").click();
    const [create] = queued("mail.activity");
    expect(create.method).toBe("create");
    expect(create.args[0][0].user_id).toBe(salespersonId);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Visit");
    // The queued row names the chosen salesperson, as a synced row would, also in
    // a sheet opened again, which resolves the queued id from the cache.
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_assignee").toHaveText(
        "Marc Demo"
    );
    await closeSheet();
    await openActivities("Office Design");
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_assignee").toHaveText(
        "Marc Demo"
    );
});

/**
 * A `DOMException` carrying the stack Hoot reads to report an error, which a
 * `DOMException` built by a script lacks.
 *
 * @param {string} message
 * @param {string} name
 */
function domExceptionWithStack(message, name) {
    const error = new DOMException(message, name);
    const frames = new Error().stack.split("\n").slice(1).join("\n");
    Object.defineProperty(error, "stack", { value: `${name}: ${message}\n${frames}` });
    return error;
}

/**
 * Writes `rows` into the framework relational-field cache of `model` as another
 * user of the same browser leaves them there. That cache is shared by the users of
 * a browser, and each user's rows are encrypted with that user's own key, so this
 * session's decryption of those rows rejects as the Web Crypto API rejects a row
 * encrypted with another key: with an "OperationError". Hoot's Web Crypto API mock
 * decrypts every row, so that rejection is applied to this session's decryption of
 * the rows written here.
 *
 * @param {string} model
 * @param {{id: number, display_name: string}[]} rows
 */
async function writeOtherUserCacheRows(model, rows) {
    const plugin = getService(OfflinePlugin);
    // Another user's key: any key other than this session's (`browser_cache_secret`).
    const otherUserCrypto = new Crypto("5a".repeat(16));
    const otherUserValues = new WeakSet();
    const values = [];
    for (const { id, display_name } of rows) {
        const value = await otherUserCrypto.encrypt(display_name);
        otherUserValues.add(value);
        values.push({ key: id, value });
    }
    patchWithCleanup(plugin._crypto, {
        async decrypt(value) {
            if (otherUserValues.has(value)) {
                throw domExceptionWithStack(
                    "The operation failed for an operation-specific reason",
                    "OperationError"
                );
            }
            return super.decrypt(...arguments);
        },
    });
    await plugin._idb.write(OfflinePlugin.MANY2X_TABLE_PREFIX + model, values);
}

/**
 * Reads every row of the framework relational-field cache of `model` and expects
 * the read to reject as the Web Crypto API rejects a row encrypted with another key.
 *
 * @param {string} model
 */
async function expectUndecryptableCache(model) {
    let error = null;
    try {
        await getService(OfflinePlugin).searchMany2XRecords(model, "");
    } catch (readError) {
        error = readError;
    }
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe("OperationError");
}

test.tags("mobile");
test("mobile activities: another user's cached types and users leave the server's types online, none offline, and the session user", async () => {
    const received = receivedCalls("mail.activity", "create");
    const setOffline = mockOffline();
    const calls = trackCalls();
    const typeReads = () => calls.filter((call) => call === "mail.activity.type/web_search_read");
    await mountPipeline();
    await animationFrame();
    expect(typeReads()).toHaveLength(1);
    // Another user of this browser cached a salesperson and an activity type that
    // this session's loads do not cache again: each read of those caches fails.
    await writeOtherUserCacheRows("res.users", [{ id: 77, display_name: "Other salesperson" }]);
    await writeOtherUserCacheRows("mail.activity.type", [{ id: 77, display_name: "Other type" }]);
    await expectUndecryptableCache("res.users");
    await expectUndecryptableCache("mail.activity.type");

    // Online: the sheet opens with no error. As without cache, the types are read
    // from the server, and the session user is the only assignee.
    await openActivities("Office Design");
    expect(".o_error_dialog").toHaveCount(0);
    expect(typeReads()).toHaveLength(2);
    expect(".o_crm_mobile_log_call").toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").toBeEnabled();
    expect(".o_crm_mobile_activity_types_notice").toHaveCount(0);
    await contains(".o_crm_mobile_schedule_followup").click();
    expect(queryAllTexts(".o_crm_mobile_activity_type option")).toEqual([
        "Email",
        "Call",
        "Upload Document",
    ]);
    expect(
        queryAll(".o_crm_mobile_activity_user option").map((option) => Number(option.value))
    ).toEqual([serverState.userId]);
    expect(".o_crm_mobile_activity_user").toHaveValue(String(serverState.userId));
    await contains(".o_crm_mobile_activity_save").click();
    await animationFrame();
    expect(
        received.map(({ args: [[vals]] }) => [vals.res_id, vals.activity_type_id, vals.user_id])
    ).toEqual([[1, 1, serverState.userId]]);
    expect(queued("mail.activity")).toEqual([]);
    await closeSheet();

    // Offline: as without cached types, no type is offered. Both openers are
    // disabled with the reason, "Mark done" stays usable, and nothing is requested.
    await setOffline(true);
    await openActivities("Office Design");
    expect(".o_error_dialog").toHaveCount(0);
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").not.toBeEnabled();
    expect(".o_crm_mobile_activity_types_notice").toHaveText("Activity types load after sync");
    expect(`${activityRow(1)} .o_crm_mobile_activity_done`).toBeEnabled();
    expect(typeReads()).toHaveLength(2);
    expect(queued("mail.activity")).toEqual([]);
});

test.tags("mobile");
test("mobile activities: a warmed type another user cached again is left out, the others are offered", async () => {
    // Ten lead activity types: more than the first page (8) of the cache search, so
    // the sheet reads the last two warmed types by id.
    await makeMockServer();
    const extraIds = MockServer.env["mail.activity.type"].create(
        ["Type 4", "Type 5", "Type 6", "Type 7", "Type 8", "Type 9", "Type 10"].map((name) => ({
            name,
        }))
    );
    const setOffline = mockOffline();
    await mountPipeline();
    await animationFrame();
    const allIds = [1, CALL_TYPE_ID, 28, ...extraIds];
    expect(await cachedActivityTypeIds()).toEqual(allIds.slice(0, 8));
    // Another user of this browser caches the last warmed type again with that
    // user's key: the read by id of the last two fails, the cache search does not.
    await writeOtherUserCacheRows("mail.activity.type", [
        { id: extraIds.at(-1), display_name: "Type 10" },
    ]);
    expect(await cachedActivityTypeIds()).toEqual(allIds.slice(0, 8));

    // Online and offline, the types the search returned are offered, with no error.
    for (const offline of [false, true]) {
        if (offline) {
            await setOffline(true);
        }
        await openActivities("Office Design");
        expect(".o_error_dialog").toHaveCount(0);
        await contains(".o_crm_mobile_schedule_followup").click();
        expect(
            queryAll(".o_crm_mobile_activity_type option")
                .map((option) => Number(option.value))
                .sort((a, b) => a - b)
        ).toEqual(allIds.slice(0, 8));
        await contains(".o_crm_mobile_activity_cancel").click();
        await closeSheet();
    }
});

test.tags("mobile");
test("mobile activities: a cache read failing otherwise than on another user's row is reported", async () => {
    expect.errors(1);
    patchWithCleanup(OfflinePlugin.prototype, {
        async searchMany2XRecords(model) {
            if (model === "res.users") {
                // A failure of the cache itself, not of a decryption.
                throw domExceptionWithStack("Cached users unreadable", "DataError");
            }
            return super.searchMany2XRecords(...arguments);
        },
    });
    await mountPipeline();
    await animationFrame();
    await contains(`${card("Office Design")} .o_crm_mobile_lead_activities_button`).click();
    await animationFrame();
    expect.verifyErrors([/Cached users unreadable/]);
    expect(".o_crm_mobile_lead_activities_sheet").toHaveCount(0);
});

test.tags("mobile");
test("mobile activities: the sheet closes when its lead is gone after a replay", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await openActivities("Quote for Chairs");
    await contains(".o_crm_mobile_schedule_followup").click();
    await contains(".o_crm_mobile_activity_summary").edit("Visit", { confirm: false });
    await contains(".o_crm_mobile_activity_save").click();
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Visit");

    // Meanwhile the lead is deleted on the server: the replay of its activity is
    // rejected (parked), and the reload that follows no longer has the lead, whose
    // sheet closes.
    MockServer.env["crm.lead"].unlink([2]);
    await reconnect(setOffline);
    const [parked] = queued("mail.activity");
    expect(parked.method).toBe("create");
    expect(Boolean(parked.extras.error)).toBe(true);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(cardNames()).toEqual(["Office Design", "Desk Upgrade"]);
});

test.tags("mobile");
test("mobile activities: Cancel is disabled while a save runs and only the saved form closes", async () => {
    mockDate("2026-10-02 10:00:00");
    const createHeld = Promise.withResolvers();
    onRpc("mail.activity", "create", () => createHeld.promise);
    const calls = trackCalls();
    await mountPipeline();
    await openActivities("Office Design");

    // The create is held: Save and Cancel are both disabled and the form stays.
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    expect(".o_crm_mobile_activity_save").not.toBeEnabled();
    expect(".o_crm_mobile_activity_cancel").not.toBeEnabled();
    expect(".o_crm_mobile_activity_cancel").toHaveAttribute("data-available-offline");
    queryFirst(".o_crm_mobile_activity_cancel").click();
    await animationFrame();
    expect(".o_crm_mobile_activity_form").toHaveCount(1);
    expect(".o_crm_mobile_activity_summary").toHaveValue("Call");

    // Released: the saved form closes and the created activity is a synced row.
    createHeld.resolve();
    await animationFrame();
    expect(calls.filter((call) => call === "mail.activity/create")).toHaveLength(1);
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(".o_crm_mobile_activity_pending").toHaveCount(0);
    expect(activityTitles()).toInclude("Call");

    await contains(".o_crm_mobile_schedule_followup").click();
    expect(".o_crm_mobile_activity_cancel").toBeEnabled();
    await contains(".o_crm_mobile_activity_cancel").click();
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(calls.filter((call) => call === "mail.activity/create")).toHaveLength(1);
});

test.tags("mobile");
test("mobile activities online: Mark done activated twice while its request runs sends one request", async () => {
    const doneHeld = Promise.withResolvers();
    onRpc("mail.activity", "action_done", () => doneHeld.promise);
    const calls = trackCalls();
    await mountPipeline();
    await openActivities("Office Design");

    // Two activations of the same button before any re-render: one request.
    const button = queryFirst(`${activityRow(1)} .o_crm_mobile_activity_done`);
    button.click();
    button.click();
    await animationFrame();
    expect(calls.filter((call) => call === "mail.activity/action_done")).toHaveLength(1);
    // While it runs, the button is disabled and busy; nothing is queued, so it
    // still reads "Mark done" and the row is not shown as done.
    const doneButton = `${activityRow(1)} .o_crm_mobile_activity_done`;
    expect(doneButton).not.toBeEnabled();
    expect(doneButton).toHaveAttribute("aria-busy", "true");
    expect(doneButton).toHaveText("Mark done");
    expect(activityRow(1)).not.toHaveClass("o_crm_mobile_activity_done_pending");
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).toBeEnabled();
    expect(queued("mail.activity")).toEqual([]);

    // Released: the activity is done on the server and leaves the reloaded rows.
    doneHeld.resolve();
    await animationFrame();
    expect(MockServer.env["mail.activity"].search_count([["id", "=", 1]])).toBe(0);
    expect(activityRow(1)).toHaveCount(0);
    expect(activityTitles()).toEqual(["Send brochure"]);
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).toBeEnabled();
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).not.toHaveAttribute("aria-busy");
    expect(calls.filter((call) => call === "mail.activity/action_done")).toHaveLength(1);
});

test.tags("mobile");
test("mobile activities offline: Mark done activated twice before a re-render queues one action_done", async () => {
    const setOffline = mockOffline();
    const doneSchedules = [];
    patchWithCleanup(OfflinePlugin.prototype, {
        scheduleORM(model, method, args) {
            if (model === "mail.activity" && method === "action_done") {
                doneSchedules.push(args);
            }
            return super.scheduleORM(...arguments);
        },
    });
    await mountPipeline();
    await setOffline(true);
    const calls = trackCalls();
    await openActivities("Office Design");

    // Both activations come from the same render (the row still reads "Mark
    // done"): the first queues the call, the second schedules nothing.
    const button = queryFirst(`${activityRow(1)} .o_crm_mobile_activity_done`);
    button.click();
    button.click();
    await animationFrame();
    expect(doneSchedules).toEqual([[[1]]]);
    expect(queued("mail.activity").map(({ method, args }) => ({ method, args }))).toEqual([
        { method: "action_done", args: [[1]] },
    ]);
    const doneButton = `${activityRow(1)} .o_crm_mobile_activity_done`;
    expect(doneButton).toHaveText("Done · Pending sync");
    expect(doneButton).not.toBeEnabled();
    expect(doneButton).not.toHaveAttribute("aria-busy");
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).toBeEnabled();
    expect(calls).toEqual([]);
});

/**
 * Sets the value of a schedule-form control as a script would, then dispatches
 * its `change` event (`<input type="date">` cannot be typed into key by key).
 *
 * @param {string} selector
 * @param {string} value
 */
async function setFormControlValue(selector, value) {
    const control = queryFirst(selector);
    control.value = value;
    await manuallyDispatchProgrammaticEvent(control, "change");
    await animationFrame();
}

test.tags("mobile");
test("mobile activities: Save with the due date cleared flags the date and schedules nothing", async () => {
    mockDate("2026-10-02 10:00:00");
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    const calls = trackCalls();
    await openActivities("Office Design");
    await contains(".o_crm_mobile_schedule_followup").click();
    await contains(".o_crm_mobile_activity_summary").edit("Send the contract", {
        confirm: false,
    });
    const date = ".o_crm_mobile_activity_date";
    expect(date).toHaveAttribute("required");
    expect(date).not.toHaveAttribute("aria-invalid");
    expect(".o_crm_mobile_activity_form .invalid-feedback").toHaveCount(0);

    // Cleared, the date fails Save, which stays enabled: nothing is scheduled, the
    // form keeps its values, and the date is flagged, described and focused.
    await setFormControlValue(date, "");
    expect(".o_crm_mobile_activity_save").toBeEnabled();
    await contains(".o_crm_mobile_activity_save").click();
    expect(queued("mail.activity")).toEqual([]);
    expect(".o_crm_mobile_activity_form").toHaveCount(1);
    expect(".o_crm_mobile_activity_summary").toHaveValue("Send the contract");
    expect(".o_crm_mobile_activity_type").toHaveValue("1");
    expect(date).toHaveClass("is-invalid");
    expect(date).toHaveClass("o_field_invalid");
    expect(date).toHaveAttribute("aria-invalid", "true");
    expect(date).toBeFocused();
    const feedback = queryFirst(".o_crm_mobile_activity_form .invalid-feedback");
    expect(feedback).toBeVisible();
    expect(feedback).toHaveText("A valid due date is required.");
    expect(date).toHaveAttribute("aria-describedby", feedback.id);
    expect(".o_crm_mobile_activity_form .is-invalid").toHaveCount(1);
    expect(".o_crm_mobile_activity_type").not.toHaveAttribute("aria-invalid");
    expect(".o_crm_mobile_activity_user").not.toHaveAttribute("aria-invalid");

    // An entered date clears the flag, and Save then schedules.
    await setFormControlValue(date, "2026-10-07");
    expect(date).not.toHaveClass("is-invalid");
    expect(date).not.toHaveAttribute("aria-invalid");
    expect(date).not.toHaveAttribute("aria-describedby");
    expect(".o_crm_mobile_activity_form .invalid-feedback").toHaveCount(0);
    await contains(".o_crm_mobile_activity_save").click();
    const [create] = queued("mail.activity");
    expect(create.method).toBe("create");
    expect(create.args[0][0]).toEqual({
        res_model: "crm.lead",
        res_id: 1,
        activity_type_id: 1,
        summary: "Send the contract",
        date_deadline: "2026-10-07",
        user_id: serverState.userId,
    });
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(calls).toEqual([]);
});

test.tags("mobile");
test("mobile activities: Save with a due date in year 0 flags the date and schedules nothing", async () => {
    mockDate("2026-10-02 10:00:00");
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    const calls = trackCalls();
    await openActivities("Office Design");
    await contains(".o_crm_mobile_schedule_followup").click();
    await contains(".o_crm_mobile_activity_summary").edit("Send the contract", {
        confirm: false,
    });
    const date = ".o_crm_mobile_activity_date";

    // "0000-01-01" is a valid Luxon date but no server date, whose years start at
    // 1. A date input sanitizes it to "" when assigned, so the control reports it
    // through its own `value` for the change it dispatches.
    const control = queryFirst(date);
    Object.defineProperty(control, "value", {
        configurable: true,
        writable: true,
        value: "0000-01-01",
    });
    await manuallyDispatchProgrammaticEvent(control, "change");
    await animationFrame();
    await contains(".o_crm_mobile_activity_save").click();
    expect(queued("mail.activity")).toEqual([]);
    expect(".o_crm_mobile_activity_form").toHaveCount(1);
    expect(".o_crm_mobile_activity_summary").toHaveValue("Send the contract");
    expect(".o_crm_mobile_activity_type").toHaveValue("1");
    expect(date).toHaveClass("is-invalid");
    expect(date).toHaveAttribute("aria-invalid", "true");
    expect(date).toBeFocused();
    const feedback = queryFirst(".o_crm_mobile_activity_form .invalid-feedback");
    expect(feedback).toHaveText("A valid due date is required.");
    expect(date).toHaveAttribute("aria-describedby", feedback.id);
    expect(".o_crm_mobile_activity_form .is-invalid").toHaveCount(1);

    // Year 1, the server's first, is scheduled.
    delete control.value;
    await setFormControlValue(date, "0001-01-01");
    expect(date).not.toHaveAttribute("aria-invalid");
    await contains(".o_crm_mobile_activity_save").click();
    const [create] = queued("mail.activity");
    expect(create.args[0][0].date_deadline).toBe("0001-01-01");
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(calls).toEqual([]);
});

test.tags("mobile");
test("mobile activities: Save with no type or assignee selected flags them and schedules nothing", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    const calls = trackCalls();
    await openActivities("Office Design");
    await contains(".o_crm_mobile_log_call").click();

    // Neither select holds one of its options any more.
    const type = ".o_crm_mobile_activity_type";
    const assignee = ".o_crm_mobile_activity_user";
    expect(type).toHaveAttribute("required");
    expect(assignee).toHaveAttribute("required");
    await setFormControlValue(type, "");
    await setFormControlValue(assignee, "");
    await contains(".o_crm_mobile_activity_save").click();
    expect(queued("mail.activity")).toEqual([]);
    expect(".o_crm_mobile_activity_form").toHaveCount(1);
    expect(".o_crm_mobile_activity_summary").toHaveValue("Call");
    for (const select of [type, assignee]) {
        expect(select).toHaveClass("is-invalid");
        expect(select).toHaveClass("o_field_invalid");
        expect(select).toHaveAttribute("aria-invalid", "true");
    }
    expect(".o_crm_mobile_activity_date").not.toHaveAttribute("aria-invalid");
    // The first flagged control is focused; each one is described by its own message.
    expect(type).toBeFocused();
    expect(queryAllTexts(".o_crm_mobile_activity_form .invalid-feedback")).toEqual([
        "An activity type is required.",
        "An assignee is required.",
    ]);
    const [typeFeedback, assigneeFeedback] = queryAll(
        ".o_crm_mobile_activity_form .invalid-feedback"
    );
    expect(typeFeedback.id).not.toBe(assigneeFeedback.id);
    expect(type).toHaveAttribute("aria-describedby", typeFeedback.id);
    expect(assignee).toHaveAttribute("aria-describedby", assigneeFeedback.id);

    // Choosing a type clears its flag only: the assignee still fails Save.
    await contains(type).select(String(CALL_TYPE_ID));
    expect(type).not.toHaveClass("is-invalid");
    expect(type).not.toHaveAttribute("aria-invalid");
    expect(assignee).toHaveClass("is-invalid");
    await contains(".o_crm_mobile_activity_save").click();
    expect(queued("mail.activity")).toEqual([]);
    expect(assignee).toBeFocused();
    expect(type).not.toHaveClass("is-invalid");

    // Cancelled and opened again, the form has no flag and schedules.
    await contains(".o_crm_mobile_activity_cancel").click();
    await contains(".o_crm_mobile_log_call").click();
    expect(".o_crm_mobile_activity_form .is-invalid").toHaveCount(0);
    expect(".o_crm_mobile_activity_form .invalid-feedback").toHaveCount(0);
    await contains(".o_crm_mobile_activity_save").click();
    const [create] = queued("mail.activity");
    expect(create.args[0][0].activity_type_id).toBe(CALL_TYPE_ID);
    expect(create.args[0][0].user_id).toBe(serverState.userId);
    expect(calls).toEqual([]);
});

test.tags("mobile");
test("mobile activities: a sheet whose form moved on during its startup reads closes on mount", async () => {
    // Once armed, the sheet's startup read of the cached types waits for release.
    let holdTypeRead = null;
    patchWithCleanup(OfflinePlugin.prototype, {
        async searchMany2XRecords(model) {
            if (model === "mail.activity.type" && holdTypeRead) {
                const held = holdTypeRead;
                holdTypeRead = null;
                await held.promise;
            }
            return super.searchMany2XRecords(...arguments);
        },
    });
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        resIds: [1, 2],
        arch: leadFormArch,
        config: { actionId: ACTION_ID },
    });
    const typeRead = Promise.withResolvers();
    holdTypeRead = typeRead;
    await contains(".o_crm_mobile_activities_button").click();
    expect(holdTypeRead).toBe(null);
    expect(".o_bottom_sheet").toHaveCount(0);

    // While the sheet of "Office Design" starts, the form moves to the next lead.
    await contains(".o_pager_next").click();
    expect(".o_field_widget[name=name] input").toHaveValue("Quote for Chairs");

    // Released: the sheet, whose lead is no longer the form's, closes as it mounts.
    typeRead.resolve();
    await animationFrame();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(document.body).not.toHaveClass("bottom-sheet-open");

    // The displayed lead's own sheet opens and stays open.
    await contains(".o_crm_mobile_activities_button").click();
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(
        ".o_crm_mobile_lead_activities_sheet header .o_crm_mobile_activities_lead_name"
    ).toHaveText("Quote for Chairs");
    expect(document.body).toHaveClass("bottom-sheet-open");
});

test.tags("mobile");
test("mobile activities: the form's sheet closes when the form moves to another lead", async () => {
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        resIds: [1, 2],
        arch: leadFormArch,
        config: { actionId: ACTION_ID },
    });
    await contains(".o_crm_mobile_activities_button").click();
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);

    // The open sheet is the UI active element: the pager hotkey of the form behind
    // it is not dispatched.
    await press(["alt", "n"]);
    await animationFrame();
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design");
    expect(".o_bottom_sheet").toHaveCount(1);

    // The form moves to the next lead under the open sheet. The form's root reload
    // emits no model event: the sheet follows its lead and closes.
    await contains(".o_pager_next").click();
    await animationFrame();
    await animationFrame();
    expect(".o_field_widget[name=name] input").toHaveValue("Quote for Chairs");
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(document.body).not.toHaveClass("bottom-sheet-open");
});

test.tags("mobile");
test("mobile activities: a card sheet closed with its lead is closed once", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await openActivities("Quote for Chairs");
    await contains(".o_crm_mobile_schedule_followup").click();
    await contains(".o_crm_mobile_activity_save").click();

    // The lead is deleted on the server: the reload after the replay drops its card
    // and its sheet, which the sheet and the card both close.
    MockServer.env["crm.lead"].unlink([2]);
    await reconnect(setOffline);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(document.body).not.toHaveClass("bottom-sheet-open");

    // Closed once: the bottom-sheet service still flags the next sheet it opens.
    await openActivities("Office Design");
    expect(document.body).toHaveClass("bottom-sheet-open");
    await closeSheet();
    expect(document.body).not.toHaveClass("bottom-sheet-open");
});

test.tags("mobile");
test("mobile activities: Save on a sheet whose lead is gone closes it once", async () => {
    let controller = null;
    patchWithCleanup(CrmMobilePipelineController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    const calls = trackCalls();
    await mountPipeline();
    await openActivities("Quote for Chairs");
    await contains(".o_crm_mobile_schedule_followup").click();
    expect(document.body).toHaveClass("bottom-sheet-open");

    // Save is activated as soon as the sheet has closed for its lead, while the
    // sheet is still displayed: the sheet is removed from the page only at the
    // next render, and the body class is dropped by its close.
    let saveOnClosingSheet = null;
    const observer = new MutationObserver(() => {
        if (!saveOnClosingSheet && !document.body.classList.contains("bottom-sheet-open")) {
            const save = queryFirst(".o_crm_mobile_activity_save");
            saveOnClosingSheet = { displayed: Boolean(save) };
            save?.click();
        }
    });
    observer.observe(document.body, { attributeFilter: ["class"] });
    after(() => observer.disconnect());

    // The lead is deleted on the server: the pipeline reload drops it, and its
    // sheet closes. The Save that follows schedules nothing and closes nothing more.
    MockServer.env["crm.lead"].unlink([2]);
    await controller.model.load();
    await animationFrame();
    await animationFrame();
    observer.disconnect();
    expect(saveOnClosingSheet).toEqual({ displayed: true });
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(document.body).not.toHaveClass("bottom-sheet-open");
    expect(calls).not.toInclude("mail.activity/create");

    // Closed once: the bottom-sheet service still flags the next sheet it opens.
    await openActivities("Office Design");
    expect(document.body).toHaveClass("bottom-sheet-open");
    await closeSheet();
    expect(document.body).not.toHaveClass("bottom-sheet-open");
});

test.tags("mobile");
test("mobile activities: types warmed after the sheet opened enable its actions in place", async () => {
    // The activities have no type, so no lead has a next activity type to cache:
    // only the warm-up brings types, and it answers once released.
    mailModels.MailActivity._records = ACTIVITY_RECORDS.map((record) => ({
        ...record,
        activity_type_id: false,
    }));
    const warmUp = Promise.withResolvers();
    onRpc("mail.activity.type", "web_search_read", () => warmUp.promise);
    const calls = trackCalls();
    await mountPipeline();
    await openActivities("Office Design");
    expect(await cachedActivityTypeIds()).toEqual([]);
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").not.toBeEnabled();

    // The warm-up ends while the sheet is open: the same sheet enables both actions.
    warmUp.resolve();
    await animationFrame();
    await animationFrame();
    expect(await cachedActivityTypeIds()).toEqual([1, CALL_TYPE_ID, 28]);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(".o_crm_mobile_log_call").toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").toBeEnabled();
    await contains(".o_crm_mobile_schedule_followup").click();
    expect(queryAllTexts(".o_crm_mobile_activity_type option").sort()).toEqual([
        "Call",
        "Email",
        "Upload Document",
    ]);
    // The sheet read them from the cache: the warm-up is the only activity request.
    expect(calls.filter((call) => call.startsWith("mail.activity"))).toEqual([
        "mail.activity.type/web_search_read",
    ]);
});
/** Activity rows the mobile root load reads per lead, and the "Show more" step. */
const ACTIVITY_PAGE = 5;

/** Titles of the seven open activities of "Office Design" (lead 1) in `mail.activity` order. */
const OFFICE_DESIGN_ACTIVITIES = [
    "Follow-up call",
    "Send brochure",
    "Extra activity 1",
    "Extra activity 2",
    "Extra activity 3",
    "Extra activity 4",
    "Extra activity 5",
];

/**
 * Gives "Office Design" (lead 1) five more open activities than its two, after
 * them in `mail.activity` order (later deadlines, higher ids): seven in total.
 */
async function addOfficeDesignActivities() {
    await makeMockServer();
    MockServer.env["mail.activity"].create(
        [1, 2, 3, 4, 5].map((index) => ({
            res_model: "crm.lead",
            res_id: 1,
            activity_type_id: 1,
            summary: `Extra activity ${index}`,
            date_deadline: `2026-10-1${index}`,
            user_id: serverState.userId,
            state: "planned",
        }))
    );
}

test.tags("mobile");
test("mobile activities: a page size raised by Show more lasts for its search in the session, in memory only", async () => {
    expect.errors(1);
    await addOfficeDesignActivities();
    let rejectRootLoad = false;
    onRpc("crm.lead", "web_read_group", () => {
        if (rejectRootLoad) {
            rejectRootLoad = false;
            throw makeServerError({ message: "Leads reload failed" });
        }
    });
    // Registered after the rejection, so that it records the rejected load too.
    const specs = rootSpecs();
    const limits = () =>
        specs
            .filter(({ method }) => method === "web_read_group")
            .map(({ specification }) => specification.activity_ids.limit);
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    expect(limits()).toEqual([ACTIVITY_PAGE]);

    // "Show more" raises the page size of the pipeline's search and stores nothing
    // in the browser storage.
    await openActivities("Office Design");
    await contains(".o_crm_mobile_activities_load_more").click();
    await animationFrame();
    expect(limits()).toEqual([ACTIVITY_PAGE, 2 * ACTIVITY_PAGE]);
    expect(Object.keys(browser.localStorage).filter((key) => key.startsWith("crm."))).toEqual([]);
    await closeSheet();

    // Opened again in the session, the pipeline requests the raised page size.
    await openAction(ACTION_ID);
    expect(limits()).toEqual([ACTIVITY_PAGE, 2 * ACTIVITY_PAGE, 2 * ACTIVITY_PAGE]);
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES);
    await closeSheet();

    // Another search keeps the first page.
    await openAction(LEADS_ACTION_ID);
    expect(limits()).toEqual([ACTIVITY_PAGE, 2 * ACTIVITY_PAGE, 2 * ACTIVITY_PAGE, ACTIVITY_PAGE]);

    // A failed "Show more" puts its search back at the first page, and the
    // pipeline's search keeps its raised page size.
    rejectRootLoad = true;
    await openActivities("Office Design");
    await contains(".o_crm_mobile_activities_load_more").click();
    await animationFrame();
    expect.verifyErrors(["Leads reload failed"]);
    await closeSheet();
    await openAction(LEADS_ACTION_ID);
    await openAction(ACTION_ID);
    expect(limits().slice(4)).toEqual([2 * ACTIVITY_PAGE, ACTIVITY_PAGE, 2 * ACTIVITY_PAGE]);
});

test.tags("mobile");
test("mobile activities: the pipeline loads one page of activities and shows more online", async () => {
    expect.errors(2);
    await addOfficeDesignActivities();
    const setOffline = mockOffline();
    const specs = rootSpecs();
    const calls = trackCalls();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    const rootLoads = () => specs.filter(({ method }) => method === "web_read_group");

    // The root load reads one page of activity rows per lead.
    expect(rootLoads()).toHaveLength(1);
    expect(rootLoads()[0].specification.activity_ids.limit).toBe(ACTIVITY_PAGE);
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));
    expect(".o_crm_mobile_activities_more_online .o_crm_mobile_activities_more_count").toHaveText(
        "2 more activities"
    );
    expect(".o_crm_mobile_activities_load_more").toHaveText("Show more");
    expect(".o_crm_mobile_activities_load_more").toBeEnabled();
    // Online only, like the pipeline's "Load more".
    expect(".o_crm_mobile_activities_load_more").not.toHaveAttribute("data-available-offline");
    expect(".o_crm_mobile_activities_more").toHaveCount(0);

    // "Show more": one root reload with the next page, no `mail.activity` read, and
    // the sheet stays open with every activity.
    calls.length = 0;
    await contains(".o_crm_mobile_activities_load_more").click();
    await animationFrame();
    expect(rootLoads()).toHaveLength(2);
    expect(rootLoads()[1].specification.activity_ids.limit).toBe(2 * ACTIVITY_PAGE);
    expect(calls.filter((call) => call === "crm.lead/web_read_group")).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("mail.activity/"))).toEqual([]);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES);
    expect(".o_crm_mobile_activities_more_online").toHaveCount(0);
    expect(".o_crm_mobile_activities_more").toHaveCount(0);
    // A lead with fewer activities than a page has nothing more to show.
    await closeSheet();
    await contains(".o_crm_mobile_pipeline_next").click();
    await openActivities("Conference Room");
    expect(activityTitles()).toEqual(["Send the quote"]);
    expect(".o_crm_mobile_activities_more_online").toHaveCount(0);
    expect(".o_crm_mobile_activities_more").toHaveCount(0);
    await closeSheet();
    // The Leads action's search, visited online, loads and caches the first page.
    await openAction(LEADS_ACTION_ID);
    expect(rootLoads()).toHaveLength(3);
    expect(rootLoads()[2].specification.activity_ids.limit).toBe(ACTIVITY_PAGE);

    // Offline, the pipeline opened again in this session asks for the raised page
    // size: its root load is served from the cache with every activity the visit
    // showed.
    await setOffline(true);
    calls.length = 0;
    await openAction(ACTION_ID);
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(0);
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES);
    expect(".o_crm_mobile_activities_more").toHaveCount(0);
    expect(".o_crm_mobile_activities_more_online").toHaveCount(0);
    expect(".o_crm_mobile_activities_load_more").toHaveCount(0);
    expect(calls.filter((call) => call.startsWith("mail.activity/"))).toEqual([]);
    await closeSheet();

    // A search whose page size was not raised asks for the first page, which its
    // online visit cached: the others wait for sync, with no "Show more".
    await openAction(LEADS_ACTION_ID);
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(0);
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));
    expect(".o_crm_mobile_activities_more").toHaveText("2 more activities after sync");
    expect(".o_crm_mobile_activities_more_online").toHaveCount(0);
    expect(".o_crm_mobile_activities_load_more").toHaveCount(0);
    expect(calls.filter((call) => call.startsWith("mail.activity/"))).toEqual([]);
    // The framework's cached root loads, served offline.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("mobile activities: one remaining activity reads in the singular, online and after sync", async () => {
    await makeMockServer();
    // "Office Design" (lead 1) gets four more open activities than its two: one
    // more than the page the root load reads.
    MockServer.env["mail.activity"].create(
        [1, 2, 3, 4].map((index) => ({
            res_model: "crm.lead",
            res_id: 1,
            activity_type_id: 1,
            summary: `Extra activity ${index}`,
            date_deadline: `2026-10-1${index}`,
            user_id: serverState.userId,
            state: "planned",
        }))
    );
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));
    expect(".o_crm_mobile_activities_more_online .o_crm_mobile_activities_more_count").toHaveText(
        "1 more activity"
    );
    expect(".o_crm_mobile_activities_load_more").toBeEnabled();
    expect(".o_crm_mobile_activities_more").toHaveCount(0);

    // Offline, the open sheet offers no "Show more": the remaining activity waits
    // for sync, still counted in the singular.
    await setOffline(true);
    await animationFrame();
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(".o_crm_mobile_activities_more_online").toHaveCount(0);
    expect(".o_crm_mobile_activities_more").toHaveText("1 more activity after sync");
    expect(".o_crm_mobile_activities_more").toHaveAttribute("role", "status");
});

// Refine D3.1 (P1): the activity sheet on iOS Safari. Chrome and current WebKit
// keep an expanded sheet's rail at its end when the sheet grows, by re-snapping
// the rail to the sheet (its mandatory scroll snapping). A rail that is not
// re-snapped (Safari without re-snapping, or any browser before the sheet's
// slide-in has enabled snapping) stays where it was, below the sheet's new end.
// Safari does not focus a tapped button either, so no focus move reveals a row:
// the sheet expands itself after the patch that grew it. On a mobile OS the
// bottom sheet also takes the browser's Back (iOS edge swipe, Android back).
test.tags("mobile");
test("mobile activities: Show more keeps the sheet expanded on an iPhone rail that is not re-snapped", async () => {
    mockUserAgent("ios");
    await addOfficeDesignActivities();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));
    expect(isSheetExpanded()).toBe(true);
    const openers = [".o_crm_mobile_log_call", ".o_crm_mobile_schedule_followup"];
    expectEqualButtonsInView(openers);

    // As in Safari, nothing moves the rail when the content grows: no re-snapping
    // and no scroll anchoring.
    const rail = queryFirst(".o_bottom_sheet_rail");
    rail.style.setProperty("scroll-snap-type", "none");
    rail.style.setProperty("overflow-anchor", "none");
    const scrollTop = rail.scrollTop;
    const scrollEnd = rail.scrollHeight - rail.clientHeight;

    // "Show more", tapped as Safari taps a button (activated, not focused), adds two
    // rows below the viewport: the sheet scrolls its rail to the new end, so its
    // sticky actions row stays in view.
    const focused = document.activeElement;
    queryFirst(".o_crm_mobile_activities_load_more").click();
    await waitUntil(() => activityTitles().length === OFFICE_DESIGN_ACTIVITIES.length);
    await animationFrame();
    expect(document.activeElement).toBe(focused);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES);
    expect(rail.scrollHeight - rail.clientHeight).toBeGreaterThan(scrollEnd);
    expect(rail.scrollTop).toBeGreaterThan(scrollTop);
    expect(isSheetExpanded()).toBe(true);
    expectEqualButtonsInView(openers);

    // The browser's Back closes the sheet and leaves the pipeline where it was.
    browser.history.back();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    expect(card("Office Design")).toHaveCount(1);
});

test.tags("mobile");
test("mobile pipeline follows the reconciliation root when a show-more load overlaps a replay", async () => {
    await addOfficeDesignActivities();
    const setOffline = mockOffline();
    /** Next `crm.lead` request to hold, per method: `{reached, release}`. */
    const holds = {};
    const hold = (method) => {
        holds[method] = { reached: Promise.withResolvers(), release: Promise.withResolvers() };
        return holds[method];
    };
    const waitIfHeld = async (method) => {
        const held = holds[method];
        delete holds[method];
        if (held) {
            held.reached.resolve();
            await held.release.promise;
        }
    };
    onRpc("crm.lead", "web_save", () => waitIfHeld("web_save"));
    onRpc("crm.lead", "read_progress_bar", () => waitIfHeld("read_progress_bar"));
    const calls = trackCalls();
    await mountPipeline();
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    // Both stages visited online.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();

    // Offline, "Quote for Chairs" ($ 200) moves to Qualified.
    await setOffline(true);
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_stage`).select(
        String(QUALIFIED)
    );
    expect(headerTexts()).toEqual(["New", "2", "$ 400"]);

    // Reconnected: the replay of the move waits for the server.
    const save = hold("web_save");
    await setOffline(false);
    await save.reached.promise;

    // Meanwhile "Show more" reloads the root: its root, built from the server data
    // of before the replay, is installed, then waits for its progress bar.
    const showMoreProgress = hold("read_progress_bar");
    await openActivities("Office Design");
    await contains(".o_crm_mobile_activities_load_more").click();
    await showMoreProgress.reached.promise;

    // The replay ends: the reconciliation reload installs a newer root and ends.
    calls.length = 0;
    save.release.resolve();
    await animationFrame();
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(calls.filter((call) => call === "crm.lead/web_read_group")).toHaveLength(1);
    expect(headerTexts()).toEqual(["New", "2", "$ 400"]);

    // The show-more load ends last: the header keeps the reconciled root's server
    // values, and that root holds the larger activity page "Show more" asked for.
    showMoreProgress.release.resolve();
    await animationFrame();
    await animationFrame();
    expect(headerTexts()).toEqual(["New", "2", "$ 400"]);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES);
    await closeSheet();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 900"]);

    // The replay disarmed the reconciliation: a later sync with nothing to replay
    // reloads nothing.
    await setOffline(true);
    calls.length = 0;
    await reconnect(setOffline);
    expect(calls).toEqual([]);
});

test.tags("mobile");
test("mobile activities: types warmed on reconnection enable a sheet opened offline", async () => {
    // No activity has a type, and the first warm-up fails: nothing is cached.
    mailModels.MailActivity._records = ACTIVITY_RECORDS.map((record) => ({
        ...record,
        activity_type_id: false,
    }));
    const warmUps = [];
    onRpc("mail.activity.type", "web_search_read", () => {
        warmUps.push(warmUps.length + 1);
        if (warmUps.length === 1) {
            throw makeServerError({ message: "Temporarily unavailable" });
        }
    });
    const setOffline = mockOffline();
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        arch: leadFormArch,
        config: { actionId: ACTION_ID },
    });
    await animationFrame();
    expect(warmUps).toEqual([1]);

    // Offline, the form's sheet opens without types: both actions are disabled.
    await setOffline(true);
    await contains(".o_crm_mobile_activities_button").click();
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(await cachedActivityTypeIds()).toEqual([]);
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").not.toBeEnabled();

    // Reconnected: the form warms the types again, and the sheet, still open,
    // enables both actions.
    await reconnect(setOffline);
    expect(warmUps).toEqual([1, 2]);
    expect(await cachedActivityTypeIds()).toEqual([1, CALL_TYPE_ID, 28]);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(".o_crm_mobile_log_call").toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").toBeEnabled();
});

test.tags("mobile");
test("mobile activities: the same pipeline retries a failed type warm-up on reconnection and on its return to a small screen", async () => {
    // No activity or lead has a type, so the root loads cache none, and the first
    // two warm-ups fail.
    mailModels.MailActivity._records = ACTIVITY_RECORDS.map((record) => ({
        ...record,
        activity_type_id: false,
    }));
    await makeMockServer();
    MockServer.env["crm.lead"].write([1, 4], { activity_type_id: false });
    const warmUps = [];
    onRpc("mail.activity.type", "web_search_read", () => {
        warmUps.push(warmUps.length + 1);
        if (warmUps.length <= 2) {
            throw makeServerError({ message: "Temporarily unavailable" });
        }
    });
    const setOffline = mockOffline();
    await mountPipeline();
    await animationFrame();
    expect(warmUps).toEqual([1]);
    expect(await cachedActivityTypeIds()).toEqual([]);

    // Reconnected: the same mounted pipeline warms the types again.
    await setOffline(true);
    await reconnect(setOffline);
    expect(warmUps).toEqual([1, 2]);
    expect(await cachedActivityTypeIds()).toEqual([]);

    // On a wide screen, no warm-up: it is a mobile-only request.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(warmUps).toEqual([1, 2]);

    // Back on a small screen: the same pipeline tries again, and succeeds.
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(warmUps).toEqual([1, 2, 3]);
    expect(await cachedActivityTypeIds()).toEqual([1, CALL_TYPE_ID, 28]);
    await openActivities("Office Design");
    expect(".o_crm_mobile_log_call").toBeEnabled();
    await closeSheet();

    // Once warmed, a reconnection warms nothing more in this session.
    await setOffline(true);
    await reconnect(setOffline);
    expect(warmUps).toEqual([1, 2, 3]);
});

test.tags("mobile");
test("mobile activities: the phone lead form loads one page of activities and shows more online", async () => {
    expect.errors(4);
    await addOfficeDesignActivities();
    const setOffline = mockOffline();
    const specs = [];
    onRpc("crm.lead", "web_read", ({ args, kwargs }) => {
        specs.push({ resId: args[0][0], specification: kwargs.specification });
    });
    const calls = trackCalls();
    await mountWithCleanup(WebClient);
    /** Opens the lead's form in a new form view, with the two leads in its pager. */
    const openLeadForm = (resId) =>
        getService("action").doAction(ACTION_ID, {
            clearBreadcrumbs: true,
            viewType: "form",
            props: { resId, resIds: [1, 2] },
        });
    await openLeadForm(1);

    // The form's own root load reads one page of the lead's activity rows.
    expect(specs).toHaveLength(1);
    expect(specs[0].specification.activity_ids.limit).toBe(ACTIVITY_PAGE);
    // An unsaved edit, still pending in its input when "Show more" is clicked.
    await contains(".o_field_widget[name=name] input").edit("Office Design Plus", {
        confirm: false,
    });
    await contains(".o_crm_mobile_activities_button").click();
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));
    expect(".o_crm_mobile_activities_more_online .o_crm_mobile_activities_more_count").toHaveText(
        "2 more activities"
    );
    expect(".o_crm_mobile_activities_more").toHaveCount(0);

    // "Show more": the lead is refreshed in place with the next page, keeping the
    // unsaved edit (nothing is saved); no `mail.activity` read, and the sheet stays
    // open with every activity.
    calls.length = 0;
    await contains(".o_crm_mobile_activities_load_more").click();
    await animationFrame();
    expect(
        calls.filter((call) => ["crm.lead/web_save", "crm.lead/web_read"].includes(call))
    ).toEqual(["crm.lead/web_read"]);
    expect(MockServer.env["crm.lead"].search_read([["id", "=", 1]], ["name"])[0].name).toBe(
        "Office Design"
    );
    expect(specs).toHaveLength(2);
    expect(specs[1].specification.activity_ids.limit).toBe(2 * ACTIVITY_PAGE);
    expect(calls.filter((call) => call.startsWith("mail.activity/"))).toEqual([]);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES);
    expect(".o_crm_mobile_activities_more_online").toHaveCount(0);
    expect(".o_crm_mobile_activities_more").toHaveCount(0);
    // The edit is still the form's own, and the form saves it.
    await closeSheet();
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design Plus");
    await contains(".o_form_button_save").click();
    expect(MockServer.env["crm.lead"].search_read([["id", "=", 1]], ["name"])[0].name).toBe(
        "Office Design Plus"
    );

    // The next lead of the pager loads its own page size: one page.
    await contains(".o_pager_next").click();
    expect(specs).toHaveLength(3);
    expect(specs[2].resId).toBe(2);
    expect(specs[2].specification.activity_ids.limit).toBe(ACTIVITY_PAGE);

    // Back on the first lead, its remembered page size is loaded again.
    await contains(".o_pager_previous").click();
    expect(specs).toHaveLength(4);
    expect(specs[3].resId).toBe(1);
    expect(specs[3].specification.activity_ids.limit).toBe(2 * ACTIVITY_PAGE);
    await contains(".o_crm_mobile_activities_button").click();
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES);
    expect(".o_crm_mobile_activities_more_online").toHaveCount(0);
    await closeSheet();

    // Offline, the form is left for another lead's form, then the first lead's form
    // is opened again: each new form asks for its lead's remembered page size and is
    // served from the cache, the first lead with every activity its visit showed.
    await setOffline(true);
    calls.length = 0;
    await openLeadForm(2);
    expect(".o_field_widget[name=name] input").toHaveValue("Quote for Chairs");
    await openLeadForm(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design Plus");
    await contains(".o_crm_mobile_activities_button").click();
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES);
    expect(".o_crm_mobile_activities_more").toHaveCount(0);
    expect(".o_crm_mobile_activities_more_online").toHaveCount(0);
    expect(".o_crm_mobile_activities_load_more").toHaveCount(0);
    expect(calls.filter((call) => call.startsWith("mail.activity/"))).toEqual([]);
    // The framework's own cached loads offline, for each form: the root and its
    // statusbar stages.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.stage/search_read",
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.stage/search_read",
    ]);
});

test.tags("mobile");
test("mobile activities: a failed show-more reload keeps one page of activities", async () => {
    expect.errors(1);
    await addOfficeDesignActivities();
    const setOffline = mockOffline();
    /** Activity page size of every root load request, the held one included. */
    const limits = [];
    let rejectRootLoad = false;
    onRpc("crm.lead", "web_read_group", ({ kwargs }) => {
        limits.push(kwargs.unfold_read_specification.activity_ids.limit);
        if (rejectRootLoad) {
            rejectRootLoad = false;
            throw makeServerError({ message: "Pipeline reload failed" });
        }
    });
    // A root load held until the connection is lost, then answered as a lost one.
    let heldRootLoad = null;
    onRpc("/*", async (request) => {
        const isRootLoad = new URL(request.url).pathname.endsWith("/crm.lead/web_read_group");
        if (isRootLoad && heldRootLoad) {
            const { promise } = heldRootLoad;
            heldRootLoad = null;
            const { params } = await request.json();
            limits.push(params.kwargs.unfold_read_specification.activity_ids.limit);
            await promise;
            return new Response("", { status: 502 });
        }
    });
    await mountPipeline();
    await openActivities("Office Design");

    // A server error reaches the framework's error handling: the sheet keeps its
    // page, and "Show more" can be tried again.
    rejectRootLoad = true;
    await contains(".o_crm_mobile_activities_load_more").click();
    await animationFrame();
    expect.verifyErrors(["Pipeline reload failed"]);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));
    expect(".o_crm_mobile_activities_load_more").toBeEnabled();

    // The connection is lost during the reload: CRM code raises no error, and the
    // pipeline and the open sheet keep the loaded page, the others waiting for sync.
    heldRootLoad = Promise.withResolvers();
    const held = heldRootLoad;
    await contains(".o_crm_mobile_activities_load_more").click();
    // The larger page was not loaded: the remembered page size is the first page,
    // so this reload asks for one more page again...
    expect(limits).toEqual([ACTIVITY_PAGE, 2 * ACTIVITY_PAGE, 2 * ACTIVITY_PAGE]);
    await setOffline(true);
    held.resolve();
    await animationFrame();
    await animationFrame();
    expect(heldRootLoad).toBe(null);
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));
    expect(".o_crm_mobile_activities_more").toHaveText("2 more activities after sync");
    expect(".o_crm_mobile_activities_load_more").toHaveCount(0);
    expect(limits).toEqual([ACTIVITY_PAGE, 2 * ACTIVITY_PAGE, 2 * ACTIVITY_PAGE]);
    // ...and forgotten again, since the larger page was neither loaded nor cached:
    // back online, the pipeline reloads one page, and "Show more" asks for one more
    // page only.
    await reconnect(setOffline);
    expect(limits).toEqual([ACTIVITY_PAGE, 2 * ACTIVITY_PAGE, 2 * ACTIVITY_PAGE, ACTIVITY_PAGE]);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));
    await contains(".o_crm_mobile_activities_load_more").click();
    await animationFrame();
    expect(limits).toEqual([
        ACTIVITY_PAGE,
        2 * ACTIVITY_PAGE,
        2 * ACTIVITY_PAGE,
        ACTIVITY_PAGE,
        2 * ACTIVITY_PAGE,
    ]);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES);
});

test.tags("mobile");
test("mobile activities: a show-more reload served the desktop variant keeps one page of activities", async () => {
    expect.errors(1);
    await addOfficeDesignActivities();
    const setOffline = mockOffline();
    /** Activity page size of every root load request, the held one included. */
    const limits = [];
    onRpc("crm.lead", "web_read_group", ({ kwargs }) => {
        limits.push(kwargs.unfold_read_specification.activity_ids.limit ?? null);
    });
    // A root load held until the connection is lost, then answered as a lost one.
    let heldRootLoad = null;
    onRpc("/*", async (request) => {
        const isRootLoad = new URL(request.url).pathname.endsWith("/crm.lead/web_read_group");
        if (isRootLoad && heldRootLoad) {
            const { promise } = heldRootLoad;
            heldRootLoad = null;
            const { params } = await request.json();
            limits.push(params.kwargs.unfold_read_specification.activity_ids.limit ?? null);
            await promise;
            return new Response("", { status: 502 });
        }
    });
    // Visited online at desktop size first, which caches the desktop variant, then
    // resized to mobile online: the mobile variant loads one page of activities.
    await resize({ width: 1366, height: 768 });
    await mountWithCleanup(WebClient);
    await openAction(LEADS_ACTION_ID);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(limits).toEqual([null, ACTIVITY_PAGE]);
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));

    // The connection is lost during "Show more", and the cached desktop variant is
    // served instead: the larger page was neither loaded nor cached, so the
    // remembered page size is forgotten again.
    heldRootLoad = Promise.withResolvers();
    const held = heldRootLoad;
    await contains(".o_crm_mobile_activities_load_more").click();
    expect(limits).toEqual([null, ACTIVITY_PAGE, 2 * ACTIVITY_PAGE]);
    await setOffline(true);
    held.resolve();
    await animationFrame();
    await animationFrame();
    expect(heldRootLoad).toBe(null);
    expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(0);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityTitles()).toEqual(["Follow-up call"]);
    expect(".o_crm_mobile_activities_more").toHaveText("6 more activities after sync");
    expect(".o_crm_mobile_activities_load_more").toHaveCount(0);
    expect(limits).toEqual([null, ACTIVITY_PAGE, 2 * ACTIVITY_PAGE]);

    // Back online, the fallback ends with a reload of the first page, and "Show
    // more" loads the next one.
    await reconnect(setOffline);
    expect(limits).toEqual([null, ACTIVITY_PAGE, 2 * ACTIVITY_PAGE, ACTIVITY_PAGE]);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));
    await contains(".o_crm_mobile_activities_load_more").click();
    await animationFrame();
    expect(limits).toEqual([
        null,
        ACTIVITY_PAGE,
        2 * ACTIVITY_PAGE,
        ACTIVITY_PAGE,
        2 * ACTIVITY_PAGE,
    ]);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES);
    // The framework's cached root load (the desktop variant), served offline.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

test.tags("mobile");
test("mobile activities: a failed phone form show-more reload keeps one page of activities", async () => {
    expect.errors(3);
    await addOfficeDesignActivities();
    const setOffline = mockOffline();
    /** `[resId, activity limit]` of every lead form root load request, the held one included. */
    const loads = [];
    let rejectLoad = false;
    onRpc("crm.lead", "web_read", ({ args, kwargs }) => {
        loads.push([args[0][0], kwargs.specification.activity_ids?.limit ?? null]);
        if (rejectLoad) {
            rejectLoad = false;
            throw makeServerError({ message: "Lead reload failed" });
        }
    });
    // A lead load held until the connection is lost, then answered as a lost one.
    let heldLoad = null;
    onRpc("/*", async (request) => {
        const isLeadLoad = new URL(request.url).pathname.endsWith("/crm.lead/web_read");
        if (isLeadLoad && heldLoad) {
            const { promise } = heldLoad;
            heldLoad = null;
            const { params } = await request.json();
            loads.push([
                params.args[0][0],
                params.kwargs.specification.activity_ids?.limit ?? null,
            ]);
            await promise;
            return new Response("", { status: 502 });
        }
    });
    // Visited online at desktop size first, which caches the desktop variant of the
    // lead's form; resized to mobile, the pager loads each lead with one page.
    await resize({ width: 1366, height: 768 });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(ACTION_ID, {
        clearBreadcrumbs: true,
        viewType: "form",
        props: { resId: 1, resIds: [1, 2] },
    });
    await resize({ width: 375, height: 667 });
    await animationFrame();
    await contains(".o_pager_next").click();
    await contains(".o_pager_previous").click();
    expect(loads).toEqual([
        [1, null],
        [2, ACTIVITY_PAGE],
        [1, ACTIVITY_PAGE],
    ]);
    await contains(".o_crm_mobile_activities_button").click();
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));

    // A server error reaches the framework's error handling: the larger page was not
    // loaded, so no larger page size is remembered.
    rejectLoad = true;
    await contains(".o_crm_mobile_activities_load_more").click();
    await animationFrame();
    expect.verifyErrors(["Lead reload failed"]);
    expect(loads.at(-1)).toEqual([1, 2 * ACTIVITY_PAGE]);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));

    // The connection is lost during "Show more": the lead is refreshed in place, so
    // the form keeps the lead and the page it shows (the cached desktop variant
    // does not replace them); the larger page was neither loaded nor cached, so the
    // remembered page size is forgotten again.
    heldLoad = Promise.withResolvers();
    const held = heldLoad;
    await contains(".o_crm_mobile_activities_load_more").click();
    // One more page than the first again: the failed refresh raised nothing.
    expect(loads.slice(3)).toEqual([
        [1, 2 * ACTIVITY_PAGE],
        [1, 2 * ACTIVITY_PAGE],
    ]);
    await setOffline(true);
    held.resolve();
    await animationFrame();
    await animationFrame();
    expect(heldLoad).toBe(null);
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design");
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));
    expect(".o_crm_mobile_activities_more").toHaveText("2 more activities after sync");
    expect(".o_crm_mobile_activities_notice").toHaveCount(0);
    expect(".o_crm_mobile_activities_load_more").toHaveCount(0);
    const loadCount = loads.length;

    // Back online, the form needs no reload, and "Show more" loads the next page.
    await reconnect(setOffline);
    expect(loads).toHaveLength(loadCount);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));
    await contains(".o_crm_mobile_activities_load_more").click();
    await animationFrame();
    expect(loads.at(-1)).toEqual([1, 2 * ACTIVITY_PAGE]);
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES);
    await closeSheet();

    // The in-place refresh is the form's own root load: offline, the pager leaves
    // the lead and comes back to it, asking for its remembered page size, which
    // only that refresh loaded, and is served that page from the cache.
    await setOffline(true);
    await contains(".o_pager_next").click();
    expect(".o_field_widget[name=name] input").toHaveValue("Quote for Chairs");
    await contains(".o_pager_previous").click();
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design");
    await contains(".o_crm_mobile_activities_button").click();
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES);
    expect(".o_crm_mobile_activities_more").toHaveCount(0);
    expect(loads.at(-1)).toEqual([1, 2 * ACTIVITY_PAGE]);
    // The framework's own cached root loads, served offline.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read",
    ]);
});

test.tags("mobile");
test("mobile activities: a phone form show-more refresh keeps the edits made while it loads", async () => {
    await addOfficeDesignActivities();
    /** `[resId, activity limit]` of every lead form root load reaching the server. */
    const loads = [];
    onRpc("crm.lead", "web_read", ({ args, kwargs }) => {
        loads.push([args[0][0], kwargs.specification.activity_ids?.limit ?? null]);
    });
    /** The next request of `hold.route` waits until `hold.release` resolves. */
    let hold = null;
    onRpc("/*", async (request) => {
        if (hold && new URL(request.url).pathname.endsWith(hold.route)) {
            const held = hold;
            hold = null;
            held.reached.resolve();
            await held.release.promise;
        }
    });
    const holdNext = (route) => {
        hold = { route, reached: Promise.withResolvers(), release: Promise.withResolvers() };
        return hold;
    };
    const controllers = [];
    patchWithCleanup(CrmFormController.prototype, {
        setup() {
            super.setup(...arguments);
            controllers.push(this);
        },
    });
    const calls = trackCalls();
    const serverLead = () =>
        MockServer.env["crm.lead"].search_read([["id", "=", 1]], ["name", "contact_name"])[0];
    await mountWithCleanup(WebClient);
    await getService("action").doAction(ACTION_ID, {
        clearBreadcrumbs: true,
        viewType: "form",
        props: { resId: 1, resIds: [1, 2] },
    });
    expect(loads).toEqual([[1, ACTIVITY_PAGE]]);

    // An unsaved edit made before "Show more".
    await contains(".o_field_widget[name=contact_name] input").edit("Ann Example");
    await contains(".o_crm_mobile_activities_button").click();
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES.slice(0, ACTIVITY_PAGE));

    // "Show more" refreshes the lead in place. While its load runs, the sheet is
    // closed and the lead is edited again: the edit waits for the refresh and
    // applies to the refreshed lead, and the earlier edit is kept too.
    calls.length = 0;
    const showMoreLoad = holdNext("/crm.lead/web_read");
    await contains(".o_crm_mobile_activities_load_more").click();
    await showMoreLoad.reached.promise;
    await closeSheet();
    await contains(".o_field_widget[name=name] input").edit("Office Design Deluxe");
    showMoreLoad.release.resolve();
    await animationFrame();
    await animationFrame();
    expect(loads.at(-1)).toEqual([1, 2 * ACTIVITY_PAGE]);
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design Deluxe");
    expect(".o_field_widget[name=contact_name] input").toHaveValue("Ann Example");
    // Nothing was saved, and no `mail.activity` read was issued.
    expect(
        calls.filter((call) => ["crm.lead/web_save", "crm.lead/web_read"].includes(call))
    ).toEqual(["crm.lead/web_read"]);
    expect(calls.filter((call) => call.startsWith("mail.activity/"))).toEqual([]);
    expect(serverLead().name).toBe("Office Design");
    await contains(".o_crm_mobile_activities_button").click();
    expect(activityTitles()).toEqual(OFFICE_DESIGN_ACTIVITIES);
    expect(".o_crm_mobile_activities_more_online").toHaveCount(0);
    await closeSheet();

    // Both edits are the form's own: the form saves them.
    await contains(".o_form_button_save").click();
    expect(serverLead().name).toBe("Office Design Deluxe");
    expect(serverLead().contact_name).toBe("Ann Example");

    // A pager move saving an edit reuses the record for the next lead while "Show
    // more" waits for it: the first lead did not get the larger page, so its page
    // size goes back to the one it had.
    await contains(".o_field_widget[name=name] input").edit("Office Design");
    const pagerSave = holdNext("/crm.lead/web_save");
    await contains(".o_pager_next").click();
    await pagerSave.reached.promise;
    const showMore = controllers.at(-1).crmLoadMoreActivities(1);
    pagerSave.release.resolve();
    await showMore;
    await animationFrame();
    expect(".o_field_widget[name=name] input").toHaveValue("Quote for Chairs");
    expect(loads.at(-1)).toEqual([2, ACTIVITY_PAGE]);
    await contains(".o_pager_previous").click();
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design");
    expect(loads.at(-1)).toEqual([1, 2 * ACTIVITY_PAGE]);
});

test.tags("mobile");
test("mobile lead form reconnected during its first load leaves the desktop fallback", async () => {
    const setOffline = mockOffline();
    /** Variant of every lead form root load reaching the server. */
    const loads = [];
    onRpc("crm.lead", "web_read", ({ kwargs }) => {
        loads.push(kwargs.specification.activity_ids ? "mobile" : "desktop");
    });
    /** The next lead form root request waits for `release`; a `lost` one then fails. */
    let hold = null;
    onRpc("/*", async (request) => {
        if (hold && new URL(request.url).pathname.endsWith("/crm.lead/web_read")) {
            const held = hold;
            hold = null;
            held.reached.resolve();
            await held.release.promise;
            if (held.lost) {
                return new Response("", { status: 502 });
            }
        }
    });
    const holdNextLoad = (lost = false) => {
        hold = { reached: Promise.withResolvers(), release: Promise.withResolvers(), lost };
        return hold;
    };
    const controllers = [];
    patchWithCleanup(CrmFormController.prototype, {
        setup() {
            super.setup(...arguments);
            controllers.push(this);
        },
    });
    /**
     * Opens the form of lead `resId`, whose first root load (the phone variant)
     * loses the connection, so the form retries it with the desktop variant; the
     * connection returns while that retry still runs, held until `release`.
     *
     * @param {number} resId
     */
    const openLosingFirstLoad = async (resId) => {
        const mobileLoad = holdNextLoad(true);
        const opened = getService("action").doAction(ACTION_ID, {
            clearBreadcrumbs: true,
            viewType: "form",
            props: { resId },
        });
        await mobileLoad.reached.promise;
        await setOffline(true);
        const desktopLoad = holdNextLoad();
        mobileLoad.release.resolve();
        await desktopLoad.reached.promise;
        await setOffline(false);
        return { opened, release: () => desktopLoad.release.resolve() };
    };
    await mountWithCleanup(WebClient);

    // A reconciliation asked for meanwhile (here directly, as a replay would) joins
    // the one the reconnection asked for.
    const first = await openLosingFirstLoad(1);
    expect(".o_form_view").toHaveCount(0);
    controllers.at(-1).crmReconcile({ dropRestored: true });
    first.release();
    await first.opened;
    await animationFrame();
    await animationFrame();

    // Once loaded, the form leaves the fallback with one reload of the phone
    // variant, whose activity rows the sheet lists.
    expect(loads).toEqual(["desktop", "mobile"]);
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design");
    await contains(".o_crm_mobile_activities_button").click();
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);
    expect(".o_crm_mobile_activities_notice").toHaveCount(0);
    await closeSheet();

    // A form left before its first load completed reloads nothing.
    const second = await openLosingFirstLoad(2);
    await openAction(ACTION_ID);
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    second.release();
    await animationFrame();
    await animationFrame();
    expect(loads).toEqual(["desktop", "mobile", "desktop"]);
});

test.tags("mobile");
test("lead form fallback widened offline reconnects without a desktop root read", async () => {
    expect.errors(2);
    const setOffline = mockOffline();
    /** Variant of every lead form root load reaching the server. */
    const loads = [];
    onRpc("crm.lead", "web_read", ({ kwargs }) => {
        loads.push(kwargs.specification.activity_ids ? "mobile" : "desktop");
    });
    const calls = trackCalls();
    const leadCalls = () => calls.filter((call) => call.startsWith("crm.lead/"));
    // Visited online at desktop size first, which caches the desktop variant of both
    // leads' forms; resized to mobile, the mounted form is reused (its view
    // description is cached per screen size).
    await resize({ width: 1366, height: 768 });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(ACTION_ID, {
        clearBreadcrumbs: true,
        viewType: "form",
        props: { resId: 1, resIds: [1, 2] },
    });
    await contains(".o_pager_next").click();
    await contains(".o_pager_previous").click();
    expect(loads).toEqual(["desktop", "desktop", "desktop"]);
    await resize({ width: 375, height: 667 });
    await animationFrame();

    // Offline on the phone, the pager asks for the phone variant of the next lead,
    // which was never cached: the form falls back to its cached desktop variant.
    await setOffline(true);
    await contains(".o_pager_next").click();
    expect(".o_field_widget[name=name] input").toHaveValue("Quote for Chairs");
    expect(".o_crm_mobile_activities_button").toHaveCount(1);

    // Widened while still offline, then reconnected with nothing queued: the root
    // already holds the desktop variant, so the form issues no lead request.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    calls.length = 0;
    await reconnect(setOffline);
    expect(leadCalls()).toEqual([]);
    expect(loads).toEqual(["desktop", "desktop", "desktop"]);
    expect(".o_field_widget[name=name] input").toHaveValue("Quote for Chairs");
    expect(".o_crm_mobile_activities_button").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);

    // A fallback that stays on the phone ends at the reconnection with one reload
    // of the phone variant, whose activity rows the sheet lists.
    await resize({ width: 375, height: 667 });
    await animationFrame();
    await setOffline(true);
    await contains(".o_pager_previous").click();
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design");
    calls.length = 0;
    await reconnect(setOffline);
    expect(leadCalls()).toEqual(["crm.lead/web_read"]);
    expect(loads).toEqual(["desktop", "desktop", "desktop", "mobile"]);
    await contains(".o_crm_mobile_activities_button").click();
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);
    expect(".o_crm_mobile_activities_notice").toHaveCount(0);
    // The framework's cached root loads (the desktop variant), served offline.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read",
    ]);
});

test.tags("mobile");
test("mobile activities: the schedule form opens in view and focused, styled like the quick create", async () => {
    await mountPipeline();
    await openActivities("Office Design");
    const sheet = queryFirst(".o_bottom_sheet_sheet");
    const openHeight = Math.round(sheet.getBoundingClientRect().height);
    const openers = [".o_crm_mobile_log_call", ".o_crm_mobile_schedule_followup"];
    expect(".o_crm_mobile_activity_actions").toHaveStyle({ position: "sticky" });
    expect(isSheetExpanded()).toBe(true);
    expectEqualButtonsInView(openers);
    // One separator spacing: the rows touch, their own padding spaces them.
    const rows = queryAll(".o_crm_mobile_activity_row").map((row) => row.getBoundingClientRect());
    expect(rows).toHaveLength(2);
    expect(Math.round(rows[1].top - rows[0].bottom)).toBe(0);
    const headerBottom = () =>
        queryFirst(".o_crm_mobile_lead_activities_sheet > header").getBoundingClientRect().bottom;
    const headerToFirstRow = Math.round(rows[0].top - headerBottom());

    // The form grows the sheet, which expands to keep Save and Cancel in view, and
    // its type takes the focus.
    const buttons = [".o_crm_mobile_activity_save", ".o_crm_mobile_activity_cancel"];
    await contains(".o_crm_mobile_log_call").click();
    expect(".o_crm_mobile_activity_type").toBeFocused();
    expect(".o_crm_mobile_activity_form_buttons").toHaveStyle({ position: "sticky" });
    expect(isSheetExpanded()).toBe(true);
    expectEqualButtonsInView(buttons);
    expect(Math.round(sheet.getBoundingClientRect().height)).toBeGreaterThan(openHeight);

    // Its controls share one radius, one font size and one focus ring.
    const controls = queryAll(".o_crm_mobile_activity_form :is(input, select)");
    expect(controls).toHaveLength(4);
    const { borderRadius, boxShadow, fontSize } = getComputedStyle(controls[0]);
    expect(borderRadius).not.toBe("0px");
    expect(boxShadow).not.toBe("none");
    for (const control of controls) {
        control.focus();
        await animationFrame();
        expect(control).toHaveStyle({ borderRadius, boxShadow, fontSize });
    }
    expect(fontSize).toBe(getComputedStyle(queryFirst(".o_crm_mobile_lead_stage")).fontSize);
    // Unfocused, the required controls are outlined darker than the optional summary.
    const requiredBorder = { borderColor: "rgb(33, 37, 41)" };
    expect(".o_crm_mobile_activity_date").toHaveStyle(requiredBorder);
    expect(".o_crm_mobile_activity_summary").not.toHaveStyle(requiredBorder);

    // Cancel gives the sheet back its height, the openers in view.
    await contains(".o_crm_mobile_activity_cancel").click();
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(Math.round(sheet.getBoundingClientRect().height)).toBe(openHeight);
    expect(isSheetExpanded()).toBe(true);
    expectEqualButtonsInView(openers);

    // The follow-up form opens the same way.
    await contains(".o_crm_mobile_schedule_followup").click();
    expect(".o_crm_mobile_activity_type").toBeFocused();
    expect(isSheetExpanded()).toBe(true);
    expectEqualButtonsInView(buttons);
    await closeSheet();

    // A lead without activities: its empty list adds no gap, so "No activities"
    // starts where a first row would.
    await openActivities("Quote for Chairs");
    expect(".o_crm_mobile_activity_row").toHaveCount(0);
    const emptyLine = queryFirst(
        ".o_crm_mobile_lead_activities_sheet .o_crm_mobile_activities_empty"
    );
    expect(Math.round(emptyLine.getBoundingClientRect().top - headerBottom())).toBe(
        headerToFirstRow
    );
});

// -----------------------------------------------------------------------------
// Refine D1.4 (R4): an activity create whose answer is lost is created once, by
// the delivery key (`CRM_OFFLINE_CREATE_KEY`) it carries online and queued alike
// -----------------------------------------------------------------------------

/**
 * Emulates the server's activity create by delivery key (the CRM `mail.activity`
 * `create` override): a create whose context carries the key
 * (`CRM_OFFLINE_CREATE_KEY`) of an activity already created answers with that
 * activity and creates nothing. The mock server also loses the answer of the next
 * creates, one per value pushed to the returned `losses`: the server creates the
 * activity, then its answer reaches the page as a lost connection (a 502). Each
 * create is stepped as `create <summary>`, or `create <summary> (delivered)` when
 * its key answered it, with ` (answer lost)` appended when its answer is lost; its
 * payload (`ormCall`) is appended to `received`.
 *
 * @returns {{losses: true[], received: Object[]}}
 */
function mockActivityCreatesByKey() {
    const state = { losses: [], received: [] };
    const activityIdsByKey = new Map();
    onRpc("mail.activity", "create", async (call) => {
        const { args, kwargs, parent } = call;
        state.received.push(JSON.parse(JSON.stringify(ormCall(call))));
        const key = kwargs.context?.[CRM_OFFLINE_CREATE_KEY];
        let step = `create ${args[0][0].summary}`;
        let result;
        if (activityIdsByKey.has(key)) {
            step += " (delivered)";
            result = [activityIdsByKey.get(key)];
        } else {
            result = await parent();
            if (typeof key === "string") {
                activityIdsByKey.set(key, result[0]);
            }
        }
        if (state.losses.length && state.losses.shift()) {
            expect.step(`${step} (answer lost)`);
            return new Response("", { status: 502 });
        }
        expect.step(step);
        return result;
    });
    return state;
}

/** Ids of the server activities of "Office Design" (lead 1) summarized `summary`. */
function officeDesignActivityIds(summary) {
    return MockServer.env["mail.activity"]
        .search_read(
            [
                ["res_model", "=", "crm.lead"],
                ["res_id", "=", 1],
                ["summary", "=", summary],
            ],
            ["id"]
        )
        .map(({ id }) => id);
}

/** The values "Log a call" schedules on "Office Design" (lead 1) on 2026-10-02. */
function officeDesignCall() {
    return {
        res_model: "crm.lead",
        res_id: 1,
        activity_type_id: CALL_TYPE_ID,
        summary: "Call",
        date_deadline: "2026-10-02",
        user_id: serverState.userId,
    };
}

test.tags("mobile");
test("mobile activities: a call logged offline whose replay answer is lost is sent again with its key and created once", async () => {
    mockDate("2026-10-02 10:00:00");
    const server = mockActivityCreatesByKey();
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await openActivities("Office Design");
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();

    // Queued with a new delivery key and the id of the session user.
    const [create] = queued("mail.activity");
    const key = create.kwargs.context[CRM_OFFLINE_CREATE_KEY];
    expect(key).toMatch(DELIVERY_KEY);
    const createCall = {
        model: "mail.activity",
        method: "create",
        args: [[officeDesignCall()]],
        kwargs: {
            context: {
                ...user.context,
                [CRM_OFFLINE_CREATE_KEY]: key,
                [CRM_OFFLINE_UID_KEY]: user.userId,
            },
        },
    };
    expect(ormCall(create)).toEqual(createCall);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_pending_sync").toHaveText("Pending sync");

    // The replay's create reaches the server, which creates the activity, but its
    // answer is lost: the create stays queued, unparked and unchanged, and its row
    // stays pending.
    server.losses.push(true);
    await setOffline(false);
    await expect.waitForSteps(["create Call (answer lost)"]);
    await animationFrame();
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    expect(officeDesignActivityIds("Call")).toHaveLength(1);
    const [kept] = queued("mail.activity");
    expect(ormCall(kept)).toEqual(createCall);
    expect(kept.extras.error).toBe(undefined);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Call");
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_pending_sync").toHaveText("Pending sync");

    // Reconnected, the replay sends the very same call, which the server answers with
    // the activity it created: one server activity, shown once as a synced row of the
    // still-open sheet.
    await reconnect(setOffline);
    expect.verifySteps(["create Call (delivered)"]);
    expect(server.received).toEqual([createCall, createCall]);
    expect(queued("mail.activity")).toEqual([]);
    const callIds = officeDesignActivityIds("Call");
    expect(callIds).toHaveLength(1);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(".o_crm_mobile_activity_pending").toHaveCount(0);
    expect(activityTitles().sort()).toEqual(["Call", "Follow-up call", "Send brochure"]);
    expect(`${activityRow(callIds[0])} .o_crm_mobile_activity_title`).toHaveText("Call");
    expect(`${activityRow(callIds[0])} .o_crm_mobile_activity_done`).toBeEnabled();
});

test.tags("mobile");
test("mobile activities: a call logged online whose answer is lost queues the key it sent and is created once", async () => {
    mockDate("2026-10-02 10:00:00");
    const server = mockActivityCreatesByKey();
    const setOffline = mockOffline();
    await mountPipeline();
    await openActivities("Office Design");

    // Saved online, the server creates the activity but its answer is lost: the
    // create is queued with the delivery key the online create sent, and its row is
    // pending in the still-open sheet.
    server.losses.push(true);
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    await expect.waitForSteps(["create Call (answer lost)"]);
    await animationFrame();
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(officeDesignActivityIds("Call")).toHaveLength(1);
    const [sent] = server.received;
    const key = sent.kwargs.context[CRM_OFFLINE_CREATE_KEY];
    expect(key).toMatch(DELIVERY_KEY);
    expect(sent).toEqual({
        model: "mail.activity",
        method: "create",
        args: [[officeDesignCall()]],
        kwargs: { context: { ...user.context, [CRM_OFFLINE_CREATE_KEY]: key } },
    });
    const [create] = queued("mail.activity");
    const queuedCall = {
        ...sent,
        kwargs: { context: { ...sent.kwargs.context, [CRM_OFFLINE_UID_KEY]: user.userId } },
    };
    expect(ormCall(create)).toEqual(queuedCall);
    expect(create.extras.error).toBe(undefined);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Call");
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_pending_sync").toHaveText("Pending sync");

    // Its replay sends the call the online create sent, queued with the id of the
    // session user, which the server answers with the activity it created: one
    // server activity, shown once as a synced row.
    await reconnect(setOffline);
    expect.verifySteps(["create Call (delivered)"]);
    expect(server.received).toEqual([sent, queuedCall]);
    expect(queued("mail.activity")).toEqual([]);
    const callIds = officeDesignActivityIds("Call");
    expect(callIds).toHaveLength(1);
    expect(".o_crm_mobile_activity_pending").toHaveCount(0);
    expect(activityTitles().sort()).toEqual(["Call", "Follow-up call", "Send brochure"]);
    expect(`${activityRow(callIds[0])} .o_crm_mobile_activity_done`).toBeEnabled();

    // A new call, logged online, carries a new key and is a second activity.
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    await expect.waitForSteps(["create Call"]);
    expect(server.received).toHaveLength(3);
    expect(server.received[2].kwargs.context[CRM_OFFLINE_CREATE_KEY]).toMatch(DELIVERY_KEY);
    expect(server.received[2].kwargs.context[CRM_OFFLINE_CREATE_KEY]).not.toBe(key);
    expect(officeDesignActivityIds("Call")).toHaveLength(2);
    expect(queued("mail.activity")).toEqual([]);
});

// -----------------------------------------------------------------------------
// Non-secure origin: controls whose offline action needs the framework queue
// (`mockNonSecureContext`, called once the view is mounted: the offline plugin
// keeps the caches it opened before)
// -----------------------------------------------------------------------------

/**
 * Asserts the state of CRM controls whose offline action queues a call. `blocked`:
 * the framework disabled them (`disabled`, `o_disabled_offline`) because they no
 * longer claim `data-available-offline`; otherwise enabled and claiming it.
 *
 * @param {string} selector
 * @param {{blocked: boolean, count?: number}} state
 */
function expectQueueControl(selector, { blocked, count = 1 }) {
    expect(selector).toHaveCount(count);
    for (const el of queryAll(selector)) {
        if (blocked) {
            expect(el).not.toBeEnabled();
            expect(el).toHaveClass("o_disabled_offline");
            expect(el).not.toHaveAttribute("data-available-offline");
        } else {
            expect(el).toBeEnabled();
            expect(el).not.toHaveClass("o_disabled_offline");
            expect(el).toHaveAttribute("data-available-offline", "1");
        }
    }
}

test.tags("mobile");
test("[Offline] non-secure origin disables New, its deep link and quick-create Save", async () => {
    // The framework's cached root load of the pipeline reopened offline.
    expect.errors(1);
    const setOffline = mockOffline();
    patchWithCleanup(quickCreateDeepLink, { pending: false });
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    mockNonSecureContext();
    await animationFrame();

    // Online, nothing changes; a sheet opened now follows the connection.
    expectQueueControl(".o_crm_mobile_pipeline_new", { blocked: false });
    await contains(".o_crm_mobile_pipeline_new").click();
    await contains("form.o_crm_mobile_quick_create input[name=name]").edit("LAN Lead", {
        confirm: false,
    });
    expectQueueControl(".o_crm_mobile_quick_create_save", { blocked: false });

    // Offline: Save is disabled; Cancel and the six fields stay available.
    await setOffline(true);
    await animationFrame();
    expectQueueControl(".o_crm_mobile_quick_create_save", { blocked: true });
    for (const el of queryAll(
        ".o_crm_mobile_quick_create_field, .o_crm_mobile_quick_create_cancel"
    )) {
        expect(el).toBeEnabled();
        expect(el).toHaveAttribute("data-available-offline", "1");
    }
    expect(".o_crm_mobile_quick_create_field").toHaveCount(6);
    // Neither a click nor Enter saves: nothing queued or shown, the draft stays.
    await click(".o_crm_mobile_quick_create_save");
    await contains("form.o_crm_mobile_quick_create input[name=name]").press("Enter");
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_notification").toHaveCount(0);
    expect(".o_crm_mobile_lead_card_provisional").toHaveCount(0);
    expect("form.o_crm_mobile_quick_create input[name=name]").toHaveValue("LAN Lead");
    await contains(".o_crm_mobile_quick_create_cancel").click();
    expect(".o_bottom_sheet").toHaveCount(0);

    // "New" is disabled and inert, and the "New Lead" deep link opens no sheet.
    expectQueueControl(".o_crm_mobile_pipeline_new", { blocked: true });
    await click(".o_crm_mobile_pipeline_new");
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    quickCreateDeepLink.pending = isQuickCreateDeepLink("?menu_id=1&crm_quick_create=1");
    await openAction(ACTION_ID);
    await animationFrame();
    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    expect(quickCreateDeepLink.pending).toBe(false);
    expect(".o_bottom_sheet").toHaveCount(0);
    expectQueueControl(".o_crm_mobile_pipeline_new", { blocked: true });
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_notification").toHaveCount(0);

    // Online again: "New" and Save are enabled, and the lead is created online.
    await setOffline(false);
    await animationFrame();
    expectQueueControl(".o_crm_mobile_pipeline_new", { blocked: false });
    await quickCreateLead({ name: "LAN Lead" });
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(MockServer.env["crm.lead"].search_count([["name", "=", "LAN Lead"]])).toBe(1);
    expect(cardNames()).toInclude("LAN Lead");
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_notification").toHaveCount(0);
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

test.tags("mobile");
test("[Offline] non-secure origin disables the activity sheet writes", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    mockNonSecureContext();
    await openActivities("Office Design");

    // Online, nothing changes; a form opened now follows the connection.
    expectQueueControl(".o_crm_mobile_log_call", { blocked: false });
    expectQueueControl(".o_crm_mobile_schedule_followup", { blocked: false });
    expectQueueControl(".o_crm_mobile_activity_done", { blocked: false, count: 2 });
    await contains(".o_crm_mobile_log_call").click();
    expectQueueControl(".o_crm_mobile_activity_save", { blocked: false });

    // Offline: Save and "Mark done" are disabled; Cancel and the inputs stay available.
    await setOffline(true);
    await animationFrame();
    expectQueueControl(".o_crm_mobile_activity_save", { blocked: true });
    expectQueueControl(".o_crm_mobile_activity_done", { blocked: true, count: 2 });
    for (const el of queryAll(
        ".o_crm_mobile_activity_form :is(select, input), .o_crm_mobile_activity_cancel"
    )) {
        expect(el).toBeEnabled();
        expect(el).toHaveAttribute("data-available-offline", "1");
    }
    expect(".o_crm_mobile_activity_form :is(select, input)").toHaveCount(4);
    await click(".o_crm_mobile_activity_save");
    await animationFrame();
    expect(".o_crm_mobile_activity_form").toHaveCount(1);
    await contains(".o_crm_mobile_activity_cancel").click();
    expect(".o_crm_mobile_activity_form").toHaveCount(0);

    // "Log a call" and "Schedule follow-up" are disabled too; none of them acts.
    expectQueueControl(".o_crm_mobile_log_call", { blocked: true });
    expectQueueControl(".o_crm_mobile_schedule_followup", { blocked: true });
    for (const selector of [
        ".o_crm_mobile_log_call",
        ".o_crm_mobile_schedule_followup",
        `${activityRow(1)} .o_crm_mobile_activity_done`,
    ]) {
        await click(selector);
    }
    await animationFrame();
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(`${activityRow(1)} .o_crm_mobile_activity_done`).toHaveText("Mark done");
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure"]);
    expect(queued("mail.activity")).toEqual([]);
    expect(".o_notification").toHaveCount(0);

    // Online again: every control is enabled, and the writes reach the server.
    await setOffline(false);
    await animationFrame();
    expectQueueControl(".o_crm_mobile_log_call", { blocked: false });
    expectQueueControl(".o_crm_mobile_schedule_followup", { blocked: false });
    expectQueueControl(".o_crm_mobile_activity_done", { blocked: false, count: 2 });
    await contains(".o_crm_mobile_log_call").click();
    expectQueueControl(".o_crm_mobile_activity_save", { blocked: false });
    await contains(".o_crm_mobile_activity_save").click();
    await animationFrame();
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(
        MockServer.env["mail.activity"].search_count([
            ["res_id", "=", 1],
            ["summary", "=", "Call"],
        ])
    ).toBe(1);
    await contains(`${activityRow(1)} .o_crm_mobile_activity_done`).click();
    await animationFrame();
    expect(activityRow(1)).toHaveCount(0);
    expect(MockServer.env["mail.activity"].search_count([["id", "=", 1]])).toBe(0);
    expect(queued("mail.activity")).toEqual([]);
    expect(".o_notification").toHaveCount(0);
});

test.tags("mobile");
test("[Offline] non-secure origin gives the activity openers the framework offline state without cached types", async () => {
    // Served from a non-secure origin from the start: the framework keeps no
    // relational-field cache there, so the types read online are not available
    // offline, where the openers are then disabled for both reasons.
    mockNonSecureContext();
    const setOffline = mockOffline();
    await mountPipeline();
    await openActivities("Office Design");

    // Online: the types come from the server, and both openers are enabled.
    expectQueueControl(".o_crm_mobile_log_call", { blocked: false });
    expectQueueControl(".o_crm_mobile_schedule_followup", { blocked: false });

    // Offline: the openers carry the framework's offline state, as "Mark done"
    // does, and still reference the reason no type is available.
    await setOffline(true);
    await animationFrame();
    expect(".o_crm_mobile_activity_types_notice").toHaveText("Activity types load after sync");
    expectQueueControl(".o_crm_mobile_log_call", { blocked: true });
    expectQueueControl(".o_crm_mobile_schedule_followup", { blocked: true });
    expectQueueControl(".o_crm_mobile_activity_done", { blocked: true, count: 2 });
    const noticeId = queryFirst(".o_crm_mobile_activity_types_notice").id;
    expect(".o_crm_mobile_log_call").toHaveAttribute("aria-describedby", noticeId);
    expect(".o_crm_mobile_schedule_followup").toHaveAttribute("aria-describedby", noticeId);
    for (const selector of [".o_crm_mobile_log_call", ".o_crm_mobile_schedule_followup"]) {
        await click(selector);
    }
    await animationFrame();
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(queued("mail.activity")).toEqual([]);
    expect(".o_notification").toHaveCount(0);

    // Online again: the types are read again, and both openers are enabled.
    await setOffline(false);
    await animationFrame();
    expect(".o_crm_mobile_activity_types_notice").toHaveCount(0);
    expectQueueControl(".o_crm_mobile_log_call", { blocked: false });
    expectQueueControl(".o_crm_mobile_schedule_followup", { blocked: false });
});

// -----------------------------------------------------------------------------
// Lead form on a phone: partner field and stage statusbar
// -----------------------------------------------------------------------------

/** The partner input of the lead form. */
const PARTNER_INPUT = ".o_field_widget[name=partner_id] input";

/** Selectors of the non-record options of a many2one dropdown. */
const NON_RECORD_OPTIONS = [
    ".o_m2o_dropdown_option_create",
    ".o_m2o_dropdown_option_create_edit",
    ".o_m2o_dropdown_option_search_more",
];

/** The partner autocomplete's "Search Worldwide" row. */
const SEARCH_WORLDWIDE = ".o-autocomplete--dropdown-item:contains(Search Worldwide)";

/**
 * Template of `PartnerAutoCompleteStandIn`, registered by
 * `registerPartnerAutocompleteStandIn`: a primary inherit of `web.AutoComplete`
 * adding the partner autocomplete's "Search Worldwide" row, rendered below the
 * options unless `shouldSearchWorldwide` is set.
 */
const PARTNER_AUTOCOMPLETE_TEMPLATE = "crm.test.MobilePartnerAutoComplete";
const PARTNER_AUTOCOMPLETE_ARCH = /* xml */ `
    <t t-name="${PARTNER_AUTOCOMPLETE_TEMPLATE}" t-inherit="web.AutoComplete" t-inherit-mode="primary">
        <xpath expr="//ul" position="inside">
            <t t-if="this.sources &amp;&amp; this.sources.at(-1)?.options.length !== 0 &amp;&amp; !this.shouldSearchWorldwide">
                <li
                    class="o-autocomplete--dropdown-item ui-menu-item d-block"
                    t-on-pointerdown="() => this.ignoreBlur = true"
                    t-on-mouseleave="() => this.onOptionMouseLeave()"
                    t-on-click="(ev) => this.searchWorldwide(ev)"
                >
                    <a
                        t-attf-id="{{this.props.id or 'autocomplete'}}_{{this.source_index}}_{{this.option_index}}"
                        role="option"
                        href="#"
                        class="dropdown-item ui-menu-item-wrapper text-truncate text-info"
                        t-att-class="{ 'ui-state-active': this.isActiveSourceOption([this.source_index, this.option_index]) }"
                        t-att-aria-selected="this.isActiveSourceOption([this.source_index, this.option_index]) ? 'true' : 'false'"
                    >
                        Search Worldwide 🌎
                    </a>
                </li>
            </t>
        </xpath>
    </t>`;

/**
 * Stand-in for the partner autocomplete's AutoComplete (`PartnerAutoComplete`):
 * `setup` assigns `shouldSearchWorldwide`, function sources receive it with the
 * request, and its "Search Worldwide" row sets it and reloads the options.
 */
class PartnerAutoCompleteStandIn extends AutoComplete {
    static template = PARTNER_AUTOCOMPLETE_TEMPLATE;

    setup() {
        super.setup();
        this.shouldSearchWorldwide = false;
    }

    loadOptions(options, request) {
        if (typeof options === "function") {
            return options(request, this.shouldSearchWorldwide);
        }
        return options;
    }

    async searchWorldwide(ev) {
        this.shouldSearchWorldwide = true;
        ev.preventDefault();
        super.close();
        super.open(true);
    }
}

class PartnerMany2XAutocompleteStandIn extends Many2XAutocomplete {
    static components = {
        ...Many2XAutocomplete.components,
        AutoComplete: PartnerAutoCompleteStandIn,
    };
}

class PartnerMany2OneStandIn extends Many2One {
    static components = {
        ...Many2One.components,
        Many2XAutocomplete: PartnerMany2XAutocompleteStandIn,
    };
}

/**
 * Registers, for the current test, a stand-in for the lead form's
 * `res_partner_many2one` widget, whose addon (`partner_autocomplete`) is outside
 * CRM's `depends` and not loaded here: a many2one whose autocomplete renders the
 * "Search Worldwide" row, and whose `otherSources` adds an enrichment suggestion for
 * queries longer than two characters. Each lookup is recorded in `lookups` as
 * `[request, queryCountryId]` (`false` for the company's country, `0` worldwide),
 * and each selected suggestion in `selections`.
 *
 * @param {{ lookups: [string, false | 0][], selections: string[] }} records
 */
function registerPartnerAutocompleteStandIn({ lookups, selections }) {
    after(
        registerTemplate(
            PARTNER_AUTOCOMPLETE_TEMPLATE,
            "/crm/static/tests/crm_mobile_pipeline.test.js",
            PARTNER_AUTOCOMPLETE_ARCH
        )
    );
    class EnrichmentPartnerMany2One extends Many2OneField {
        static components = { ...Many2OneField.components, Many2One: PartnerMany2OneStandIn };

        get m2oProps() {
            const enrichmentSource = {
                options: (request, shouldSearchWorldwide) => {
                    if (request.length <= 2) {
                        return [];
                    }
                    lookups.push([request, shouldSearchWorldwide ? 0 : false]);
                    return [
                        {
                            cssClass: "partner_autocomplete_dropdown_many2one",
                            data: { name: "Azure Interior SA" },
                            label: "Azure Interior SA",
                            onSelect: () => selections.push("Azure Interior SA"),
                        },
                    ];
                },
                placeholder: "Searching Autocomplete...",
            };
            return { ...super.m2oProps, otherSources: [enrichmentSource] };
        }
    }
    // Replaces the default stand-in every test registers; restored after the test
    // with the rest of the registries.
    registry
        .category("fields")
        .add("res_partner_many2one", buildM2OFieldDescription(EnrichmentPartnerMany2One), {
            force: true,
        });
}

/**
 * Types `value` into the lead partner field and waits for its suggestions.
 *
 * @param {string} value
 */
async function searchPartner(value) {
    await contains(PARTNER_INPUT).edit(value, { confirm: false });
    // Past the autocomplete debounce, without running the offline plugin's timers.
    await advanceTime(500);
    await animationFrame();
}

/**
 * Opens the "Quote for Chairs" lead form (no partner) from the pipeline, which
 * loads (and caches) the partners of the pipeline's leads.
 */
async function openQuoteForChairs() {
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(`${card("Quote for Chairs")} .o_crm_mobile_lead_open`).click();
    expect(".o_form_view").toHaveCount(1);
}

test.tags("mobile");
test("[Offline] phone partner field searches cached names with zero requests and no create", async () => {
    const lookups = [];
    const selections = [];
    registerPartnerAutocompleteStandIn({ lookups, selections });
    // Registered before `mockOffline`: sees only the requests the server answers.
    const serverCalls = trackCalls();
    const setOffline = mockOffline();
    await openQuoteForChairs();
    // Online, the phone keeps the framework's select-create path (readonly input).
    expect(PARTNER_INPUT).toHaveAttribute("readonly");

    await setOffline(true);
    serverCalls.splice(0);
    // Registered after `mockOffline`: also sees the attempts the lost network refuses.
    const attempts = trackCalls();
    // Offline, the field searches the cached partners inline.
    expect(PARTNER_INPUT).not.toHaveAttribute("readonly");
    expect(".o_field_widget[name=partner_id] .o-autocomplete").toHaveCount(1);

    // A name no cached partner matches: no create option, no worldwide search.
    await searchPartner("Nobody");
    expect(queryAllTexts(".o-autocomplete--dropdown-item")).toEqual(["No records"]);
    for (const option of [...NON_RECORD_OPTIONS, SEARCH_WORLDWIDE]) {
        expect(option).toHaveCount(0);
    }

    // A cached name: the partner is offered and selected.
    await searchPartner("Deco");
    expect(queryAllTexts(".o-autocomplete--dropdown-item")).toEqual(["Deco Addict"]);
    for (const option of [...NON_RECORD_OPTIONS, SEARCH_WORLDWIDE]) {
        expect(option).toHaveCount(0);
    }
    // No enrichment lookup was made.
    expect(lookups).toEqual([]);
    await contains(".o-autocomplete--dropdown-item:contains(Deco Addict)").click();
    expect(PARTNER_INPUT).toHaveValue("Deco Addict");
    expect(".modal").toHaveCount(0);

    // Saved offline with the selected partner.
    await contains(".o_form_button_save").click();
    const [save] = queued("crm.lead");
    expect(save.args[0]).toEqual([2]);
    expect(save.args[1].partner_id).toBe(102);

    // No request reached the server. The record searches read the cached partners
    // without attempting any request; the only attempt the lost network refused is
    // the framework's record save, which queues the call. No `name_search`, no
    // select-create dialog, no enrichment lookup.
    expect(serverCalls).toEqual([]);
    expect(attempts.filter((call) => call !== "crm.lead/web_save")).toEqual([]);
});

test.tags("mobile");
test("[Offline] phone partner field offers no cached partner, with no error, after another user cached one", async () => {
    const setOffline = mockOffline();
    await openQuoteForChairs();
    // Another user of this browser cached a partner: every read of the cached
    // partners fails.
    await writeOtherUserCacheRows("res.partner", [{ id: 1, display_name: "Other partner" }]);
    await expectUndecryptableCache("res.partner");

    // Offline, the field's inline search of every cached partner offers none, as
    // without cache, with no create option and no error.
    await setOffline(true);
    expect(PARTNER_INPUT).not.toHaveAttribute("readonly");
    await contains(PARTNER_INPUT).click();
    await animationFrame();
    expect(queryAllTexts(".o-autocomplete--dropdown-item")).toEqual(["No records"]);
    for (const option of NON_RECORD_OPTIONS) {
        expect(option).toHaveCount(0);
    }
    expect(".o_error_dialog").toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
});

test.tags("mobile");
test("[Offline] stale enrichment and create options opened online do nothing", async () => {
    const autocompletes = [];
    patchWithCleanup(AutoComplete.prototype, {
        setup() {
            super.setup(...arguments);
            autocompletes.push(this);
        },
    });
    const relationalAutocompletes = [];
    patchWithCleanup(Many2XAutocomplete.prototype, {
        setup() {
            super.setup(...arguments);
            relationalAutocompletes.push(this);
        },
    });
    const lookups = [];
    const enrichmentSelections = [];
    registerPartnerAutocompleteStandIn({ lookups, selections: enrichmentSelections });
    // The wide-layout "Search more..." dialog lists the partners.
    mailModels.ResPartner._views = {
        ...mailModels.ResPartner._views,
        list: /* xml */ `<list><field name="display_name"/></list>`,
        search: /* xml */ `<search><field name="name"/></search>`,
    };
    const setOffline = mockOffline();
    await openQuoteForChairs();
    // The phone has no dropdown online (select-create path): the dropdown is opened
    // online on a wide layout, where the field autocompletes.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    expect(PARTNER_INPUT).not.toHaveAttribute("readonly");

    /** The record option, and the non-record ones (create, create and edit, search more, enrichment). */
    const RECORD_ITEM =
        ".o-autocomplete--dropdown-item:contains(Azure Interior):not(.partner_autocomplete_dropdown_many2one)";
    const STALE_ITEMS = [...NON_RECORD_OPTIONS, ".partner_autocomplete_dropdown_many2one"].map(
        (option) => `.o-autocomplete--dropdown-item${option}`
    );
    /**
     * Every option renders selectable: an `<a role="option">`, not styled disabled;
     * the worldwide search is offered below them.
     */
    const expectSelectable = () => {
        for (const item of [RECORD_ITEM, ...STALE_ITEMS, SEARCH_WORLDWIDE]) {
            expect(`${item} a.dropdown-item[role=option]`).toHaveCount(1);
        }
        expect(".o-autocomplete--dropdown-item.o_disabled_offline").toHaveCount(0);
    };
    /**
     * The non-record options render unselectable (a `<span>`, no role) with the
     * framework's offline-disabled styling; the record option does not. The
     * worldwide search is not rendered.
     */
    const expectStaleInert = () => {
        for (const item of STALE_ITEMS) {
            expect(`${item} span.dropdown-item:not([role])`).toHaveCount(1);
            expect(`${item} a`).toHaveCount(0);
            expect(`${item}.o_disabled_offline`).toHaveCount(1);
        }
        expect(`${RECORD_ITEM} a.dropdown-item[role=option]`).toHaveCount(1);
        expect(`${RECORD_ITEM}.o_disabled_offline`).toHaveCount(0);
        expect(SEARCH_WORLDWIDE).toHaveCount(0);
    };
    let calls = [];
    /**
     * Opens the dropdown online with "Azu": every option is selectable, and the
     * enrichment lookup searches the company's country (`false`).
     */
    const openOnline = async () => {
        await setOffline(false);
        await searchPartner("Azu");
        expect(queryAllTexts(".o-autocomplete--dropdown-item")).toEqual([
            "Azure Interior",
            'Create "Azu"',
            "Create and edit...",
            "Search more...",
            "Azure Interior SA",
            "Search Worldwide 🌎",
        ]);
        expectSelectable();
        expect(lookups.at(-1)).toEqual(["Azu", false]);
    };
    /**
     * Disconnects with the dropdown open: its options stay, the non-record ones
     * inert, and the worldwide search is removed.
     */
    const disconnect = async () => {
        await setOffline(true);
        calls = trackCalls();
        expect(".o-autocomplete--dropdown-item").toHaveCount(5);
        expectStaleInert();
    };
    /**
     * Nothing happened: the dropdown is still open and the input unchanged; no
     * request, dialog, enrichment, partner or queued call.
     */
    const expectNothingHappened = () => {
        expect(".o-autocomplete--dropdown-menu").toHaveCount(1);
        expect(PARTNER_INPUT).toHaveValue("Azu");
        expect(calls).toEqual([]);
        expect(enrichmentSelections).toEqual([]);
        expect(".modal").toHaveCount(0);
        expect(queued("crm.lead")).toEqual([]);
        expect(queued("res.partner")).toEqual([]);
    };

    // The open dropdown follows the connection without reloading its options.
    await openOnline();
    await disconnect();
    await setOffline(false);
    expect(".o-autocomplete--dropdown-item").toHaveCount(6);
    expectSelectable();
    await disconnect();

    // Clicked: not selected, the dropdown stays open.
    for (const item of STALE_ITEMS) {
        await contains(item).click();
        await animationFrame();
        expectNothingHappened();
        expectStaleInert();
    }
    // With no worldwide search to click, the focus stays in the input, and Escape
    // still closes the dropdown.
    expect(PARTNER_INPUT).toBeFocused();
    await press("Escape");
    await animationFrame();
    expect(".o-autocomplete--dropdown-menu").toHaveCount(0);

    // Chosen with the keyboard: Enter on an option made active online.
    for (const [index, item] of STALE_ITEMS.entries()) {
        await openOnline();
        // The record option is active first; each ArrowDown moves to the next option.
        for (let i = 0; i <= index; i++) {
            await press("ArrowDown");
        }
        await animationFrame();
        expect(`${item} .ui-state-active[aria-selected=true]`).toHaveCount(1);
        expect(PARTNER_INPUT).toHaveAttribute("aria-activedescendant", queryFirst(`${item} a`).id);
        await disconnect();
        // Inert, it is no longer the active option.
        expect(".o-autocomplete--dropdown-item .ui-state-active").toHaveCount(0);
        expect(`${item} [aria-selected=true]`).toHaveCount(0);
        expect(PARTNER_INPUT).not.toHaveAttribute("aria-activedescendant");
        await press("Enter");
        await animationFrame();
        expectNothingHappened();
    }

    // Offline, the keyboard only ever reaches the record option.
    for (let i = 0; i <= STALE_ITEMS.length; i++) {
        await press("ArrowDown");
        await animationFrame();
        expect(queryAllTexts(".o-autocomplete--dropdown-item .ui-state-active")).toEqual([
            "Azure Interior",
        ]);
    }
    expectNothingHappened();

    // Called directly: the options AutoComplete renders stay unselectable and inert.
    const partnerAutocomplete = autocompletes.findLast((autocomplete) =>
        autocomplete.inputRef()?.closest(".o_field_widget[name=partner_id]")
    );
    const options = partnerAutocomplete.sources.flatMap((source) => source.options);
    const staleOptions = options.filter((option) => !option.data?.record);
    expect(staleOptions).toHaveLength(4);
    for (const option of staleOptions) {
        expect(option.unselectable).toBe(true);
        expect(option.onSelect()).toBe(undefined);
    }
    expect(
        options.filter((option) => option.data?.record).map((option) => option.unselectable)
    ).toEqual([false]);
    await animationFrame();
    expectNothingHappened();
    // The field's own "Search more" and barcode entry points do nothing either.
    const partnerField = relationalAutocompletes.findLast((autocomplete) =>
        autocomplete.autocompleteContainerRef()?.closest(".o_field_widget[name=partner_id]")
    );
    await partnerField.onSearchMore("Azu");
    await partnerField.onBarcodeSearch();
    await animationFrame();
    expectNothingHappened();
    // A direct worldwide search does nothing but prevent its event's default action:
    // the open dropdown keeps the options loaded online (none reloaded), no
    // enrichment lookup is made, and the flag is not remembered for the next online
    // lookup (checked below).
    const lookupCount = lookups.length;
    const callSearchWorldwide = async () => {
        const event = new MouseEvent("click", { cancelable: true });
        await partnerAutocomplete.searchWorldwide(event);
        await advanceTime(500);
        await animationFrame();
        expect(event.defaultPrevented).toBe(true);
    };
    await callSearchWorldwide();
    expect(queryAllTexts(".o-autocomplete--dropdown-item")).toEqual([
        "Azure Interior",
        'Create "Azu"',
        "Create and edit...",
        "Search more...",
        "Azure Interior SA",
    ]);
    expectStaleInert();
    expect(lookups).toHaveLength(lookupCount);
    expectNothingHappened();

    // The record option stays usable, and on the phone the field searches inline.
    await contains(RECORD_ITEM).click();
    expect(PARTNER_INPUT).toHaveValue("Azure Interior");
    expect(".o-autocomplete--dropdown-menu").toHaveCount(0);
    // With the dropdown closed, a direct worldwide search does not open it.
    await callSearchWorldwide();
    expect(".o-autocomplete--dropdown-menu").toHaveCount(0);
    expect(PARTNER_INPUT).toHaveValue("Azure Interior");
    expect(lookups).toHaveLength(lookupCount);
    expect(calls).toEqual([]);
    // Reconnected, the enrichment lookup still searches the company's country, with
    // the worldwide search offered; Search more opens its dialog.
    await setOffline(false);
    await searchPartner("Azu");
    expect(lookups.at(-1)).toEqual(["Azu", false]);
    expect(lookups.every(([, queryCountryId]) => queryCountryId === false)).toBe(true);
    expect(`${SEARCH_WORLDWIDE} a.dropdown-item[role=option]`).toHaveCount(1);
    await searchPartner("De");
    await contains(".o-autocomplete--dropdown-item.o_m2o_dropdown_option_search_more").click();
    expect(".modal .o_list_view").toHaveCount(1);
    await contains(".modal .btn-close").click();
    expect(".modal").toHaveCount(0);
    await setOffline(true);
    await resize({ width: 375, height: 667 });
    await animationFrame();
    await searchPartner("Az");
    expect(queryAllTexts(".o-autocomplete--dropdown-item")).toEqual(["Azure Interior"]);
});

test.tags("mobile");
test("[Online] phone partner field opens select-create", async () => {
    mailModels.ResPartner._views = {
        ...mailModels.ResPartner._views,
        kanban: /* xml */ `
            <kanban>
                <templates>
                    <t t-name="card"><field name="display_name"/></t>
                </templates>
            </kanban>`,
        search: /* xml */ `<search><field name="name"/></search>`,
    };
    const setOffline = mockOffline();
    await openQuoteForChairs();
    await setOffline(true);
    expect(PARTNER_INPUT).not.toHaveAttribute("readonly");

    // Reconnected: the phone's select-create path is back.
    await setOffline(false);
    expect(PARTNER_INPUT).toHaveAttribute("readonly");
    expect(".o_field_widget[name=partner_id] .o-autocomplete").toHaveCount(0);
    await contains(PARTNER_INPUT).click();
    expect(".modal .o_kanban_view").toHaveCount(1);
    expect(".modal .modal-title").toHaveText("Search: Customer");
    await contains(".modal .o_kanban_record:contains(Deco Addict)").click();
    expect(".modal").toHaveCount(0);
    expect(PARTNER_INPUT).toHaveValue("Deco Addict");
});

/**
 * The statusbar's all-stages dropdown toggle (the phone statusbar; its "More..."
 * toggles carry an `aria-label`).
 */
const STAGE_DROPDOWN_TOGGLE = ".o_statusbar_status button.dropdown-toggle:not([aria-label])";

test.tags("mobile");
test("[Offline] form stage change queues through the statusbar", async () => {
    expect.errors(1);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();
    expect(STAGE_DROPDOWN_TOGGLE).toHaveText("New");

    await setOffline(true);
    const calls = trackCalls();
    // The phone statusbar: one toggle opening every stage, all usable offline.
    expect(STAGE_DROPDOWN_TOGGLE).toHaveAttribute("data-available-offline");
    expect(STAGE_DROPDOWN_TOGGLE).toBeEnabled();
    await contains(STAGE_DROPDOWN_TOGGLE).click();
    const items = queryAll(".o-dropdown--menu .dropdown-item");
    expect(items.map((item) => item.textContent.trim())).toEqual(["New", "Qualified", "Won"]);
    for (const item of items) {
        expect(item).toHaveAttribute("data-available-offline");
    }
    await contains(".o-dropdown--menu .dropdown-item:contains(Qualified)").click();
    expect(STAGE_DROPDOWN_TOGGLE).toHaveText("Qualified");
    await contains(".o_form_button_save").click();

    const [save] = queued("crm.lead");
    expect(save.method).toBe("web_save");
    expect(save.args[0]).toEqual([1]);
    expect(save.args[1]).toEqual({ stage_id: QUALIFIED });
    // Only the framework's record save attempt, which queues the call: the stage
    // change's rainbowman lookup is skipped offline.
    expect(calls).toEqual(["crm.lead/web_save"]);

    // Back in the pipeline, the lead is listed in its new stage, pending.
    await contains(".o_back_button").click();
    expect(cardNames()).toEqual(["Quote for Chairs", "Desk Upgrade"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(textOf(`${card("Office Design")} .o_crm_mobile_pending_sync`)).toBe("Pending sync");

    // Its card moves it back to its server stage, where the pipeline still holds
    // it: the choice is saved (queued after the form's write, so it wins on replay)
    // instead of being ignored.
    await contains(`${card("Office Design")} .o_crm_mobile_lead_stage`).select(String(NEW));
    expect(cardNames()).toEqual(["Conference Room", "Lamps", "Storage Racks"]);
    const writes = queued("crm.lead");
    expect(writes.map(({ method, args }) => [method, args])).toEqual([
        ["web_save", [[1], { stage_id: QUALIFIED }]],
        ["web_save", [[1], { stage_id: NEW }]],
    ]);
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
    // The framework's own cached pipeline load offline.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

test.tags("mobile");
test("[Offline] card stage choices after a move back to the server stage replay last", async () => {
    expect.errors(1);
    const received = receivedCalls("crm.lead", "web_save");
    const setOffline = mockOffline();
    const calls = trackCalls();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();
    // The framework's start-up sync (3 s after the plugin starts) runs now, with an
    // empty queue: the mocked lock manager would not keep it from replaying the queue
    // a second time beside the reconnection's sync.
    await runAllTimers();

    // A held clock: the next writes are all queued in the same millisecond.
    let clock = Date.now();
    const start = clock;
    patchWithCleanup(Date, { now: () => clock });
    /** Queued lead writes as `[stage_id, timeStamp - start]`, in replay order. */
    const stageWrites = () =>
        queued("crm.lead").map(({ args, extras }) => [args[1].stage_id, extras.timeStamp - start]);
    /** The `timeStamp - start` of the queued lead writes, in ascending order. */
    const writeTimes = () => stageWrites().map(([, time]) => time);
    await setOffline(true);

    // B: the form saves "Qualified" through its own Record.
    await contains(STAGE_DROPDOWN_TOGGLE).click();
    await contains(".o-dropdown--menu .dropdown-item:contains(Qualified)").click();
    await contains(".o_form_button_save").click();
    await contains(".o_back_button").click();
    // A: the card moves the lead back to its server stage, "New", queued after B.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(`${card("Office Design")} .o_crm_mobile_lead_stage`).select(String(NEW));
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);

    // C: the card then chooses "Won" through the framework's group move, which would
    // queue it at the held time, the time of B and before A: the card's save is queued
    // as an entry of its own after A instead, so the choice is queued last too.
    await contains(`${card("Office Design")} .o_crm_mobile_lead_stage`).select(String(WON));
    expect(stageWrites().at(-1)).toEqual([WON, 2]);
    expect(writeTimes()).toEqual([0, 1, 2]);
    expect(cardNames()).toEqual(["Quote for Chairs", "Desk Upgrade"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Won");
    expect(cardNames()).toEqual(["Office Design"]);
    expect(`${card("Office Design")} .o_crm_mobile_lead_stage`).toHaveValue(String(WON));

    // D, a minute later: the card's Record queues "Qualified" into its own queued save,
    // C, which no other queued write of the stage follows: the choice is queued last.
    clock += 60_000;
    await contains(`${card("Office Design")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    expect(stageWrites().at(-1)).toEqual([QUALIFIED, 2]);
    expect(writeTimes()).toEqual([0, 1, 2]);
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(cardNames()).toEqual(["Office Design", "Conference Room", "Lamps", "Storage Racks"]);
    expect(`${card("Office Design")} .o_crm_mobile_lead_stage`).toHaveValue(String(QUALIFIED));
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 800"]);

    // Each pipeline write carries the stage the lead showed before it, as the
    // framework's saves do, so the offline systray lists every queued write, the
    // pipeline's as "previous stage → chosen stage".
    expect(queued("crm.lead").at(-1).extras.originalValues).toEqual({
        stage_id: { id: WON, display_name: "Won" },
    });
    await contains("div.o_nav_entry.o_offline_systray").click();
    expect(".o_offline_systray_content .o-dropdown-item").toHaveCount(3);
    const systrayChanges = queryAll(
        ".o_offline_systray_content .o-dropdown-item [data-tooltip-info]"
    ).map((el) => JSON.parse(el.dataset.tooltipInfo).changes);
    expect(systrayChanges).toEqual([
        [["stage_id", "New", "Qualified"]],
        [["stage_id", "Qualified", "New"]],
        [["stage_id", "Won", "Qualified"]],
    ]);
    await press("Escape");
    await animationFrame();
    expect(".o_offline_systray_content").toHaveCount(0);

    // Each a lead write with an empty specification, in the context of its Record: B
    // in the form's (the pipeline context), the card's writes in the card's, which
    // adds the `default_stage_id` the framework gives the stage group the lead was
    // loaded in. Each is queued with the id of the session user.
    const formContext = {
        ...user.context,
        ...PIPELINE_CONTEXT,
        [CRM_OFFLINE_UID_KEY]: user.userId,
    };
    const cardContext = { ...formContext, default_stage_id: NEW };
    const stageWrite = (stageId, context) => ({
        model: "crm.lead",
        method: "web_save",
        args: [[1], { stage_id: stageId }],
        kwargs: { context, specification: {} },
    });
    const writes = [
        stageWrite(QUALIFIED, formContext),
        stageWrite(NEW, cardContext),
        stageWrite(QUALIFIED, cardContext),
    ];
    expect(queued("crm.lead").map(ormCall)).toEqual(writes);

    // Replayed in timestamp order (B, then A, then the card's own write, C then D), the
    // last choice reaches the server last.
    const replayStart = calls.length;
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(received.map(({ args }) => args[1].stage_id)).toEqual([QUALIFIED, NEW, QUALIFIED]);
    expect(received).toEqual(writes);
    expect(calls.slice(replayStart).filter((call) => WRITE_CALL.test(call))).toEqual(
        Array(3).fill("crm.lead/web_save")
    );
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(QUALIFIED);
    expect(cardNames()).toEqual(["Office Design", "Conference Room", "Lamps", "Storage Racks"]);
    expect(".modal").toHaveCount(0);
    // The framework's own cached pipeline load offline.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

// Refine D1.3 (R3): a stage chosen online on a lead card while the replay has still
// to send the lead's queued form save is sent after it, so the card's choice, made
// last, is the stage the server keeps.

/**
 * Opens the pipeline in the web client and the form of "Office Design" (1) from its
 * card, lets the framework's start-up sync run (empty queue), then, offline, queues
 * a rename of "Quote for Chairs" (2) and, a minute later, saves "Qualified" in the
 * form, and goes back to the pipeline (served from the cache). Reconnected, the
 * replay sends the rename first, which the mock server holds until `release()`: the
 * form save of "Office Design" is then still to be replayed.
 *
 * Each `crm.lead` `web_save` reaching the mock server is recorded in `received` as
 * its `args`, on arrival; `holdWrite(args)` may return a promise the server waits
 * for before applying it.
 *
 * @param {(args: any[]) => Promise<void>|undefined} [holdWrite]
 */
async function startReplayBeforeFormSave(holdWrite = () => undefined) {
    const received = [];
    const rename = Promise.withResolvers();
    onRpc("crm.lead", "web_save", async ({ args }) => {
        received.push(JSON.parse(JSON.stringify(args)));
        if (args[0][0] === 2) {
            await rename.promise;
        }
        await holdWrite(args);
    });
    const setOffline = mockOffline();
    const calls = trackCalls();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();
    // The framework's start-up sync (3 s after the plugin starts), with an empty queue.
    await runAllTimers();
    const plugin = getService(OfflinePlugin);
    let clock = Date.now();
    patchWithCleanup(Date, { now: () => clock });

    await setOffline(true);
    const renameKey = plugin.scheduleORM(
        "crm.lead",
        "web_save",
        [[2], { name: "Chairs Quote" }],
        { context: { ...user.context, ...PIPELINE_CONTEXT }, specification: {} },
        {
            extras: {
                actionId: ACTION_ID,
                viewType: "form",
                displayName: "Chairs Quote",
                timeStamp: clock,
                changes: { name: "Chairs Quote" },
                originalValues: { name: "Quote for Chairs" },
            },
        }
    );
    clock += 60_000;
    await contains(STAGE_DROPDOWN_TOGGLE).click();
    await contains(".o-dropdown--menu .dropdown-item:contains(Qualified)").click();
    await contains(".o_form_button_save").click();
    await contains(".o_back_button").click();
    expect(queued("crm.lead").map(({ args }) => args)).toEqual([
        [[2], { name: "Chairs Quote" }],
        [[1], { stage_id: QUALIFIED }],
    ]);
    expect(received).toEqual([]);

    await setOffline(false);
    await waitUntil(() => received.length === 1);
    expect(received).toEqual([[[2], { name: "Chairs Quote" }]]);
    expect(plugin.syncingORM()).toBe(true);
    return {
        calls,
        plugin,
        received,
        /** Answers the rename; the replay sends the form save one second later. */
        async release() {
            rename.resolve();
            await waitUntil(() => !(renameKey in plugin._ormToSync()));
            await advanceTime(1000);
        },
    };
}

/**
 * Shows the stage `stageName` of the mobile pipeline, from the displayed one.
 *
 * @param {string} stageName
 */
async function showStage(stageName) {
    while (
        textOf(".o_crm_mobile_pipeline_stage_name") !== stageName &&
        queryFirst(".o_crm_mobile_pipeline_next:enabled")
    ) {
        await contains(".o_crm_mobile_pipeline_next").click();
    }
    while (
        textOf(".o_crm_mobile_pipeline_stage_name") !== stageName &&
        queryFirst(".o_crm_mobile_pipeline_prev:enabled")
    ) {
        await contains(".o_crm_mobile_pipeline_prev").click();
    }
    expect(".o_crm_mobile_pipeline_stage_name").toHaveText(stageName);
}

test.tags("mobile");
test("[Online] mobile card stage chosen during the replay of the lead's queued form save is sent after it", async () => {
    // The framework's own cached pipeline load offline (back from the form).
    expect.errors(1);
    // The card's save is answered only once released, to show that the pipeline's
    // reconciliation reload at the end of the replay waits for it.
    const cardSave = Promise.withResolvers();
    const { calls, plugin, received, release } = await startReplayBeforeFormSave((args) =>
        args[0][0] === 1 && args[1].stage_id === WON ? cardSave.promise : undefined
    );

    // Online meanwhile, the card of the lead, which its queued form save shows in
    // "Qualified", chooses "Won": the choice is not sent ahead of that save.
    await showStage("Qualified");
    await contains(`${card("Office Design")} .o_crm_mobile_lead_stage`).select(String(WON));
    await animationFrame();
    expect(received.length).toBe(1);
    // While its save waits, the card already shows the choice: it leaves "Qualified"
    // for "Won", although the form save it follows is still queued.
    expect(cardNames()).not.toInclude("Office Design");
    await showStage("Won");
    expect(`${card("Office Design")} .o_crm_mobile_lead_stage`).toHaveValue(String(WON));
    expect(received.length).toBe(1);

    // The form save replays one second later, then the card's choice is sent.
    await release();
    await waitUntil(() => received.length === 3);
    expect(received.slice(1)).toEqual([
        [[1], { stage_id: QUALIFIED }],
        [[1], { stage_id: WON }],
    ]);
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    // The replay is over, and the reconciliation reload of the pipeline waits for the
    // card's save to be answered.
    const answeredAt = calls.length;
    await animationFrame();
    expect(calls.slice(answeredAt)).not.toInclude("crm.lead/web_read_group");
    cardSave.resolve();
    await waitUntil(() => calls.slice(answeredAt).includes("crm.lead/web_read_group"));
    await animationFrame();
    await animationFrame();

    // The server keeps the card's stage, which the reloaded pipeline shows.
    expect(serverStage(1)).toEqual([{ id: 1, stage_id: [WON, "Won"] }]);
    expect(MockServer.env["crm.lead"].browse(2)[0].name).toBe("Chairs Quote");
    await showStage("Won");
    await waitFor(card("Office Design"));
    expect(`${card("Office Design")} .o_crm_mobile_lead_stage`).toHaveValue(String(WON));
    expect(`${card("Office Design")} .o_crm_mobile_pending_sync`).toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

test.tags("mobile");
test("[Online] mobile card moved back to its server stage during the replay of the lead's queued form save is sent after it", async () => {
    // The framework's own cached pipeline load offline (back from the form).
    expect.errors(1);
    const { plugin, received, release } = await startReplayBeforeFormSave();

    // Online meanwhile, the card of the lead, which its queued form save shows in
    // "Qualified", chooses its server stage "New" again: the lead's own write of that
    // stage is not sent ahead of the queued form save.
    await showStage("Qualified");
    await contains(`${card("Office Design")} .o_crm_mobile_lead_stage`).select(String(NEW));
    await animationFrame();
    expect(received.length).toBe(1);
    // While the write waits, the card already shows its server stage again.
    expect(cardNames()).not.toInclude("Office Design");
    await showStage("New");
    expect(`${card("Office Design")} .o_crm_mobile_lead_stage`).toHaveValue(String(NEW));
    expect(received.length).toBe(1);

    await release();
    await waitUntil(() => received.length === 3);
    expect(received.slice(1)).toEqual([
        [[1], { stage_id: QUALIFIED }],
        [[1], { stage_id: NEW }],
    ]);
    await advanceTime(1000);
    await animationFrame();
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(serverStage(1)).toEqual([{ id: 1, stage_id: [NEW, "New"] }]);
    await showStage("New");
    expect(cardNames()).toInclude("Office Design");
    expect(`${card("Office Design")} .o_crm_mobile_lead_stage`).toHaveValue(String(NEW));
    expect(".modal").toHaveCount(0);
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
});

// -----------------------------------------------------------------------------
// Activity sheet of the lead form: online writes reload the form's lead without
// losing its unsaved edits, and never wait on a queued save of the lead
// -----------------------------------------------------------------------------

/**
 * Opens the lead form of `resId` at mobile size, on its own (no pipeline), and
 * returns its controller.
 *
 * @param {number} resId
 */
async function openLeadFormController(resId) {
    let controller = null;
    patchWithCleanup(CrmFormController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(ACTION_ID, {
        clearBreadcrumbs: true,
        viewType: "form",
        props: { resId },
    });
    expect(".o_form_view").toHaveCount(1);
    return controller;
}

test.tags("mobile");
test("mobile activities from a dirty lead form keep its unsaved edits online", async () => {
    mockDate("2026-10-02 10:00:00");
    let heldCreate = null;
    onRpc("mail.activity", "create", () => heldCreate?.promise);
    const saves = [];
    onRpc("crm.lead", "web_save", ({ args }) => {
        saves.push(args.slice(0, 2));
    });
    const calls = trackCalls();
    const form = await openLeadFormController(1);
    const leadReads = () => calls.filter((call) => call === "crm.lead/web_read").length;
    expect(leadReads()).toBe(1);

    // An unsaved edit, then a call logged online from the form's activity sheet; the
    // phone is edited while the create request is held.
    await contains(".o_field_widget[name=name] input").edit("Office Design (edited)");
    await contains(".o_crm_mobile_activities_button").click();
    await contains(".o_crm_mobile_log_call").click();
    heldCreate = Promise.withResolvers();
    const { resolve } = heldCreate;
    await contains(".o_crm_mobile_activity_save").click();
    expect(calls.at(-1)).toBe("mail.activity/create");
    await form.model.root.update({ phone: "+32 470 99 99 99" });
    heldCreate = null;
    resolve();
    await animationFrame();

    // One reload of the lead lists the new activity; both edits are kept, unsaved.
    expect(leadReads()).toBe(2);
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure", "Call"]);
    expect(form.model.root.dirty).toBe(true);
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design (edited)");
    expect(".o_field_widget[name=phone] input").toHaveValue("+32 470 99 99 99");

    // Marked done online: one more reload, the edits are still kept.
    await contains(`${activityRow(2)} .o_crm_mobile_activity_done`).click();
    await animationFrame();
    expect(leadReads()).toBe(3);
    expect(activityRow(2)).toHaveCount(0);
    expect(form.model.root.dirty).toBe(true);
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design (edited)");
    expect(".o_field_widget[name=phone] input").toHaveValue("+32 470 99 99 99");
    expect(saves).toEqual([]);

    // Saving the form writes both edits.
    await closeSheet();
    await contains(".o_form_button_save").click();
    expect(saves).toEqual([[[1], { name: "Office Design (edited)", phone: "+32 470 99 99 99" }]]);
    expect(queued("crm.lead")).toEqual([]);
    expect(queued("mail.activity")).toEqual([]);
});

test.tags("mobile");
test("mobile activities from a lead form with a parked save complete online", async () => {
    let rejectSave = false;
    onRpc("crm.lead", "web_save", () => {
        if (rejectSave) {
            throw makeServerError({ message: "Save refused" });
        }
    });
    const setOffline = mockOffline();
    const form = await openLeadFormController(1);

    // An offline save of the lead, parked by a rejected replay.
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Office Design (parked)");
    await contains(".o_form_button_save").click();
    rejectSave = true;
    await reconnect(setOffline);
    const [parked] = queued("crm.lead");
    expect(parked.extras.error).toInclude("Save refused");

    // A call logged online completes: the lead reload does not wait on the
    // restoration of the parked save, whose values the form keeps showing.
    await contains(".o_crm_mobile_activities_button").click();
    await contains(".o_crm_mobile_log_call").click();
    await contains(".o_crm_mobile_activity_save").click();
    await animationFrame();
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Send brochure", "Call"]);
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design (parked)");
    await closeSheet();

    // A direct reload of the lead resolves too, then restores the parked save.
    let loaded = false;
    form.model.root.load().then(() => {
        loaded = true;
    });
    await animationFrame();
    await animationFrame();
    expect(loaded).toBe(true);
    expect(".o_field_widget[name=name] input").toHaveValue("Office Design (parked)");
    expect(queued("crm.lead").map(({ key, method }) => [key, method])).toEqual([
        [parked.key, "web_save"],
    ]);
    expect(MockServer.env["crm.lead"].browse(1)[0].name).toBe("Office Design");
});

// -----------------------------------------------------------------------------
// Keyboard focus and bottom-sheet lifecycle
// -----------------------------------------------------------------------------

/**
 * Presses Tab (Shift+Tab with `shift`) `count` times, and returns the elements
 * focused after each press that are outside the open bottom sheet.
 *
 * @param {number} count
 * @param {boolean} [shift]
 * @returns {Promise<Element[]>}
 */
async function focusEscapes(count, shift = false) {
    const escapes = [];
    for (let i = 0; i < count; i++) {
        await press(shift ? ["shift", "Tab"] : "Tab");
        if (!document.activeElement?.closest(".o_bottom_sheet")) {
            escapes.push(document.activeElement);
        }
    }
    return escapes;
}

/** The env the overlay service holds for the open bottom sheet. */
function bottomSheetEnv() {
    const overlays = Object.values(getService("overlay").overlays);
    return overlays.find((overlay) => overlay.component === BottomSheet)?.env;
}

test.tags("mobile");
test("mobile quick create takes the focus, keeps Tab inside and gives it back to New on every close", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    const newButton = ".o_crm_mobile_pipeline_new";
    const title = ".o_bottom_sheet .o_crm_mobile_quick_create_title";
    const nameInput = "form.o_crm_mobile_quick_create input[name=name]";
    const cancel = ".o_crm_mobile_quick_create_cancel";

    // Opened: the title takes the focus, not the name input (no phone keyboard).
    await contains(newButton).click();
    expect(title).toBeFocused();
    expect(title).toHaveAttribute("tabindex", "-1");
    // Tab goes from the title to the first field, Shift+Tab from it wraps to the
    // last control; neither ever reaches the pipeline behind the sheet.
    await press("Tab");
    expect(nameInput).toBeFocused();
    await press(["shift", "Tab"]);
    expect(cancel).toBeFocused();
    await press("Tab");
    expect(nameInput).toBeFocused();
    queryFirst(title).focus();
    await press(["shift", "Tab"]);
    expect(cancel).toBeFocused();
    expect(await focusEscapes(12)).toEqual([]);
    expect(await focusEscapes(12, true)).toEqual([]);

    // Escape closes it, and New has the focus again.
    await press("Escape");
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(newButton).toBeFocused();

    // Cancel, then the backdrop.
    await contains(newButton).click();
    expect(title).toBeFocused();
    await contains(cancel).click();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(newButton).toBeFocused();
    await contains(newButton).click();
    await closeSheet();
    expect(newButton).toBeFocused();

    // A saved lead (queued offline) closes it too.
    await contains(newButton).click();
    await contains(nameInput).edit("Focused Lead", { confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(card("Focused Lead")).toHaveClass("o_crm_mobile_lead_card_provisional");
    expect(newButton).toBeFocused();
});

test.tags("mobile");
test("mobile quick create gives the focus back to Save once a failed save re-enables it", async () => {
    expect.errors(1);
    const saveHeld = Promise.withResolvers();
    onRpc("crm.lead", "web_save", async () => {
        await saveHeld.promise;
        throw makeServerError({ message: "Invalid lead" });
    });
    await mountPipeline();
    await contains(".o_crm_mobile_pipeline_new").click();
    await contains("form.o_crm_mobile_quick_create input[name=name]").edit("Rejected Lead", {
        confirm: false,
    });
    const save = ".o_crm_mobile_quick_create_save";
    await contains(save).click();
    // While it runs, Save is disabled and busy.
    expect(save).not.toBeEnabled();
    expect(save).toHaveAttribute("aria-busy", "true");

    // The failure re-enables Save, which has the focus again once the error dialog
    // shown over the sheet is closed.
    saveHeld.resolve();
    await animationFrame();
    await animationFrame();
    expect(".o_bottom_sheet form.o_crm_mobile_quick_create").toHaveCount(1);
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute("aria-busy");
    expect(".o_dialog").toHaveCount(1);
    await contains(".o_dialog .btn-close").click();
    await animationFrame();
    expect(".o_dialog").toHaveCount(0);
    expect(".o_bottom_sheet form.o_crm_mobile_quick_create").toHaveCount(1);
    expect(save).toBeFocused();
    expect.verifyErrors(["Invalid lead"]);
});

test.tags("mobile");
test("mobile activity sheet takes the focus, keeps Tab inside and gives it back to its card", async () => {
    await mountPipeline();
    const opener = `${card("Office Design")} .o_crm_mobile_lead_activities_button`;
    const heading = ".o_bottom_sheet .o_crm_mobile_lead_activities_sheet h4";

    await openActivities("Office Design");
    expect(heading).toBeFocused();
    expect(heading).toHaveAttribute("tabindex", "-1");
    // From the heading, Tab reaches the first "Mark done" and Shift+Tab wraps to
    // the last action; the cards behind the sheet are never reached.
    await press("Tab");
    expect(`${activityRow(1)} .o_crm_mobile_activity_done`).toBeFocused();
    queryFirst(heading).focus();
    await press(["shift", "Tab"]);
    expect(".o_crm_mobile_schedule_followup").toBeFocused();
    await press("Tab");
    expect(`${activityRow(1)} .o_crm_mobile_activity_done`).toBeFocused();
    expect(await focusEscapes(8)).toEqual([]);
    expect(await focusEscapes(8, true)).toEqual([]);

    // Escape, then the backdrop: the activities button has the focus again.
    await press("Escape");
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(opener).toBeFocused();
    await openActivities("Office Design");
    expect(heading).toBeFocused();
    await closeSheet();
    expect(opener).toBeFocused();
});

test.tags("mobile");
test("mobile bottom sheets are the UI active element while they are open", async () => {
    await mountPipeline();
    const pageActiveElement = getService("ui").activeElement;

    // The page's hotkeys (such as the kanban ones) are not dispatched meanwhile.
    await openActivities("Office Design");
    expect(getService("ui").activeElement).toBe(
        queryFirst(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet")
    );
    await closeSheet();
    await animationFrame();
    expect(getService("ui").activeElement).toBe(pageActiveElement);

    await contains(".o_crm_mobile_pipeline_new").click();
    expect(getService("ui").activeElement).toBe(
        queryFirst(".o_bottom_sheet form.o_crm_mobile_quick_create")
    );
    await closeSheet();
    await animationFrame();
    expect(getService("ui").activeElement).toBe(pageActiveElement);
});

test.tags("mobile");
test("mobile activity sheet without an enabled control keeps the focus on its heading", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    // Nothing cached for the types (neither the cache search nor the read by id
    // of the warmed types finds one), and offline no type is read from the server:
    // both actions are disabled; the two rows are marked done offline, so their
    // buttons are disabled too.
    patchWithCleanup(OfflinePlugin.prototype, {
        async searchMany2XRecords(model) {
            if (model === "mail.activity.type") {
                return [];
            }
            return super.searchMany2XRecords(...arguments);
        },
        async readMany2XRecords(model) {
            if (model === "mail.activity.type") {
                return [];
            }
            return super.readMany2XRecords(...arguments);
        },
    });
    await openActivities("Office Design");
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").not.toBeEnabled();
    await contains(`${activityRow(1)} .o_crm_mobile_activity_done`).click();
    await animationFrame();
    await contains(`${activityRow(2)} .o_crm_mobile_activity_done`).click();
    await animationFrame();
    expect(".o_bottom_sheet button:enabled").toHaveCount(0);
    const heading = ".o_bottom_sheet .o_crm_mobile_lead_activities_sheet h4";
    expect(heading).toBeFocused();

    // Neither Tab nor Shift+Tab leaves the heading for the page behind the sheet.
    await press("Tab");
    expect(heading).toBeFocused();
    await press(["shift", "Tab"]);
    expect(heading).toBeFocused();
});

test.tags("mobile");
test("mobile activity sheet of the lead form gives the focus back to its Activities button", async () => {
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        arch: leadFormArch,
        config: { actionId: ACTION_ID },
    });
    const opener = ".o_crm_mobile_activities_button";
    const heading = ".o_bottom_sheet .o_crm_mobile_lead_activities_sheet h4";

    await contains(opener).click();
    expect(heading).toBeFocused();
    expect(await focusEscapes(8)).toEqual([]);
    await press("Escape");
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(opener).toBeFocused();

    await contains(opener).click();
    expect(heading).toBeFocused();
    await closeSheet();
    expect(opener).toBeFocused();
});

test.tags("mobile");
test("mobile activity sheet closed with its lead gives the focus to the card now at its place", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await setOffline(true);
    await openActivities("Quote for Chairs");
    await contains(".o_crm_mobile_schedule_followup").click();
    await contains(".o_crm_mobile_activity_summary").edit("Visit", { confirm: false });
    await contains(".o_crm_mobile_activity_save").click();
    expect(".o_crm_mobile_schedule_followup").toBeFocused();

    // The lead is deleted on the server: the reload after the replay closes its
    // sheet and removes its card, whose place the next card takes, with the focus.
    MockServer.env["crm.lead"].unlink([2]);
    await reconnect(setOffline);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(cardNames()).toEqual(["Office Design", "Desk Upgrade"]);
    expect(`${card("Desk Upgrade")} .o_crm_mobile_lead_open`).toBeFocused();
});

test.tags("mobile");
test("mobile pipeline stage navigation hands the focus over at the first and the last stage", async () => {
    await mountPipeline();
    const prev = ".o_crm_mobile_pipeline_prev";
    const next = ".o_crm_mobile_pipeline_next";

    await contains(next).click();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Qualified");
    expect(next).toBeFocused();
    // The last stage disables Next: Previous takes the focus.
    await contains(next).click();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Won");
    expect(next).not.toBeEnabled();
    expect(prev).toBeFocused();
    await contains(prev).click();
    expect(prev).toBeFocused();
    // The first stage disables Previous: Next takes the focus.
    await contains(prev).click();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("New");
    expect(prev).not.toBeEnabled();
    expect(next).toBeFocused();

    // A swipe with the focus outside the pipeline leaves it there.
    queryFirst(next).blur();
    await swipe(-120);
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Qualified");
    expect(document.activeElement).toBe(document.body);
});

test.tags("mobile");
test("mobile lead card stage move hands the focus to the card now at its place", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    // Both stages visited online.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_prev").click();
    await setOffline(true);
    const moveFocused = async (name) => {
        const select = `${card(name)} .o_crm_mobile_lead_stage`;
        await contains(select).focus();
        expect(select).toBeFocused();
        await contains(select).select(String(QUALIFIED));
    };

    // The stage selector of the card at the moved card's place takes the focus,
    // so the next lead can be moved the same way...
    await moveFocused("Quote for Chairs");
    expect(cardNames()).toEqual(["Office Design", "Desk Upgrade"]);
    expect(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).toBeFocused();
    // ... else that of the card before it...
    await moveFocused("Desk Upgrade");
    expect(cardNames()).toEqual(["Office Design"]);
    expect(`${card("Office Design")} .o_crm_mobile_lead_stage`).toBeFocused();
    // ... else the stage header's New.
    await moveFocused("Office Design");
    expect(cardNames()).toEqual([]);
    expect(".o_crm_mobile_pipeline_new").toBeFocused();
    expect(queued("crm.lead")).toHaveLength(3);
});

test.tags("mobile");
test("mobile activities: Mark done and the schedule form hand the focus on inside the sheet", async () => {
    const setOffline = mockOffline();
    await mountPipeline();
    await openActivities("Office Design");
    const done = (id) => `${activityRow(id)} .o_crm_mobile_activity_done`;

    // Online, the done row leaves: the "Mark done" now at its place takes the focus.
    await contains(done(1)).click();
    await animationFrame();
    expect(activityRow(1)).toHaveCount(0);
    expect(done(2)).toBeFocused();

    // Offline, the done row stays with its button disabled: with no other "Mark
    // done" left, "Log a call" takes the focus.
    await setOffline(true);
    await contains(done(2)).click();
    await animationFrame();
    expect(done(2)).toHaveText("Done · Pending sync");
    expect(done(2)).not.toBeEnabled();
    expect(".o_crm_mobile_log_call").toBeFocused();

    // The form replaces its openers: its first control takes the focus; Cancel
    // gives it back to the action that opened it.
    await contains(".o_crm_mobile_log_call").click();
    expect(".o_crm_mobile_activity_type").toBeFocused();
    await contains(".o_crm_mobile_activity_cancel").click();
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(".o_crm_mobile_log_call").toBeFocused();

    // A saved form gives it back to its opener too.
    await contains(".o_crm_mobile_schedule_followup").click();
    expect(".o_crm_mobile_activity_type").toBeFocused();
    await contains(".o_crm_mobile_activity_summary").edit("Visit", { confirm: false });
    await contains(".o_crm_mobile_activity_save").click();
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Visit");
    expect(".o_crm_mobile_schedule_followup").toBeFocused();

    // An invalid Save still focuses the first flagged control.
    await contains(".o_crm_mobile_schedule_followup").click();
    await setFormControlValue(".o_crm_mobile_activity_date", "");
    await contains(".o_crm_mobile_activity_save").click();
    expect(".o_crm_mobile_activity_date").toHaveClass("is-invalid");
    expect(".o_crm_mobile_activity_date").toBeFocused();
});

test.tags("mobile");
test("mobile bottom sheets are given their opener's env and leave the overlays on close", async () => {
    const openerEnvs = [];
    patchWithCleanup(CrmMobilePipeline.prototype, {
        openQuickCreate() {
            openerEnvs.push(this.env);
            return super.openQuickCreate(...arguments);
        },
    });
    patchWithCleanup(CrmMobileLeadCard.prototype, {
        openActivities() {
            openerEnvs.push(this.env);
            return super.openActivities(...arguments);
        },
    });
    patchWithCleanup(CrmFormController.prototype, {
        openMobileActivities() {
            openerEnvs.push(this.env);
            return super.openMobileActivities(...arguments);
        },
    });
    const overlayCount = () => Object.keys(getService("overlay").overlays).length;
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    const baseOverlays = overlayCount();

    // Each sheet's overlay holds its opener's env (the view's, with its model),
    // never the web client's, and is removed once the sheet closes.
    await contains(".o_crm_mobile_pipeline_new").click();
    expect(openerEnvs).toHaveLength(1);
    expect(bottomSheetEnv()).toBe(openerEnvs[0]);
    // A view's env: the web client's has no model.
    expect(bottomSheetEnv().model).not.toBe(undefined);
    await closeSheet();
    expect(bottomSheetEnv()).toBe(undefined);
    expect(overlayCount()).toBe(baseOverlays);

    await openActivities("Office Design");
    expect(openerEnvs).toHaveLength(2);
    expect(bottomSheetEnv()).toBe(openerEnvs[1]);
    await closeSheet();
    expect(bottomSheetEnv()).toBe(undefined);
    expect(overlayCount()).toBe(baseOverlays);

    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();
    const formOverlays = overlayCount();
    await contains(".o_crm_mobile_activities_button").click();
    expect(openerEnvs).toHaveLength(3);
    expect(bottomSheetEnv()).toBe(openerEnvs[2]);
    expect(openerEnvs[2].model.root.resId).toBe(1);
    await closeSheet();
    expect(bottomSheetEnv()).toBe(undefined);
    expect(overlayCount()).toBe(formOverlays);
});

test.tags("mobile");
test("mobile activity sheet keeps the focus inside while a held Save runs", async () => {
    let createHeld = null;
    onRpc("mail.activity", "create", () => createHeld?.promise);
    let sheet = null;
    patchWithCleanup(CrmMobileLeadActivities.prototype, {
        setup() {
            super.setup(...arguments);
            sheet = this;
        },
    });
    await mountPipeline();
    const heading = ".o_bottom_sheet .o_crm_mobile_lead_activities_sheet h4";
    const save = ".o_crm_mobile_activity_save";
    const cancel = ".o_crm_mobile_activity_cancel";
    await openActivities("Office Design");

    // While the create runs, Save and Cancel are disabled: the heading holds the
    // focus, through a reload of the opener's model too.
    await contains(".o_crm_mobile_log_call").click();
    createHeld = Promise.withResolvers();
    await contains(save).click();
    expect(save).not.toBeEnabled();
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(cancel).not.toBeEnabled();
    expect(heading).toBeFocused();
    sheet.props.model.notify();
    await animationFrame();
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(heading).toBeFocused();

    // Released: the saved form gives the focus to the action that opened it.
    createHeld.resolve();
    await animationFrame();
    await animationFrame();
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(activityTitles()).toInclude("Call");
    expect(".o_crm_mobile_log_call").toBeFocused();

    // Held again: from the heading, Tab reaches the first "Mark done" and
    // Shift+Tab the assignee, the last enabled control; neither ever leaves the
    // sheet.
    await contains(".o_crm_mobile_log_call").click();
    createHeld = Promise.withResolvers();
    await contains(save).click();
    expect(heading).toBeFocused();
    await press("Tab");
    expect(`${activityRow(1)} .o_crm_mobile_activity_done`).toBeFocused();
    queryFirst(heading).focus();
    await press(["shift", "Tab"]);
    expect(".o_crm_mobile_activity_user").toBeFocused();
    expect(await focusEscapes(10)).toEqual([]);
    expect(await focusEscapes(10, true)).toEqual([]);

    // The user moved the focus meanwhile: the end of the save leaves it there.
    await contains(`${activityRow(2)} .o_crm_mobile_activity_done`).focus();
    createHeld.resolve();
    await animationFrame();
    await animationFrame();
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(`${activityRow(2)} .o_crm_mobile_activity_done`).toBeFocused();
});

test.tags("mobile");
test("mobile activity sheet keeps the focus inside while a held Mark done runs", async () => {
    let doneHeld = null;
    onRpc("mail.activity", "action_done", () => doneHeld?.promise);
    await mountPipeline();
    const heading = ".o_bottom_sheet .o_crm_mobile_lead_activities_sheet h4";
    const done = (id) => `${activityRow(id)} .o_crm_mobile_activity_done`;
    const followUp = ".o_crm_mobile_schedule_followup";
    await openActivities("Office Design");

    // While the first "Mark done" runs, the heading holds the focus; once its row
    // is gone, the "Mark done" now at its place takes it.
    doneHeld = Promise.withResolvers();
    await contains(done(1)).click();
    expect(done(1)).not.toBeEnabled();
    expect(done(1)).toHaveAttribute("aria-busy", "true");
    expect(heading).toBeFocused();
    doneHeld.resolve();
    await animationFrame();
    await animationFrame();
    expect(activityRow(1)).toHaveCount(0);
    expect(done(2)).toBeFocused();

    // Held again: Tab and Shift+Tab from the heading stay inside the sheet.
    doneHeld = Promise.withResolvers();
    await contains(done(2)).click();
    expect(heading).toBeFocused();
    await press(["shift", "Tab"]);
    expect(followUp).toBeFocused();
    await press("Tab");
    expect(".o_crm_mobile_log_call").toBeFocused();
    expect(await focusEscapes(6)).toEqual([]);
    expect(await focusEscapes(6, true)).toEqual([]);

    // The user moved the focus meanwhile: it is not taken to "Log a call", where
    // the last row's completion would have handed it.
    queryFirst(heading).focus();
    await press(["shift", "Tab"]);
    expect(followUp).toBeFocused();
    doneHeld.resolve();
    await animationFrame();
    await animationFrame();
    expect(activityRow(2)).toHaveCount(0);
    expect(followUp).toBeFocused();
});

test.tags("mobile");
test("mobile quick create keeps the focus inside while a held save runs", async () => {
    let saveHeld = null;
    onRpc("crm.lead", "web_save", () => saveHeld?.promise);
    await mountPipeline();
    const newButton = ".o_crm_mobile_pipeline_new";
    const title = ".o_bottom_sheet .o_crm_mobile_quick_create_title";
    const nameInput = "form.o_crm_mobile_quick_create input[name=name]";
    const save = ".o_crm_mobile_quick_create_save";

    // While the create runs, the title holds the focus; the saved lead closes the
    // sheet, and New has the focus again.
    await contains(newButton).click();
    await contains(nameInput).edit("Held Lead", { confirm: false });
    saveHeld = Promise.withResolvers();
    await contains(save).click();
    expect(save).not.toBeEnabled();
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(title).toBeFocused();
    saveHeld.resolve();
    await animationFrame();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(cardNames()).toInclude("Held Lead");
    expect(newButton).toBeFocused();

    // Held again: Tab and Shift+Tab from the title stay inside the sheet, and the
    // saved lead still gives the focus back to New.
    await contains(newButton).click();
    await contains(nameInput).edit("Second Held Lead", { confirm: false });
    saveHeld = Promise.withResolvers();
    await contains(save).click();
    expect(title).toBeFocused();
    await press("Tab");
    expect(nameInput).toBeFocused();
    queryFirst(title).focus();
    await press(["shift", "Tab"]);
    expect(".o_crm_mobile_quick_create_cancel").toBeFocused();
    expect(await focusEscapes(12)).toEqual([]);
    expect(await focusEscapes(12, true)).toEqual([]);
    saveHeld.resolve();
    await animationFrame();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(cardNames()).toInclude("Second Held Lead");
    expect(newButton).toBeFocused();
});

test.tags("mobile");
test("mobile quick create leaves the focus the user moved during a failed save", async () => {
    expect.errors(1);
    const saveHeld = Promise.withResolvers();
    onRpc("crm.lead", "web_save", async () => {
        await saveHeld.promise;
        throw makeServerError({ message: "Invalid lead" });
    });
    await mountPipeline();
    const title = ".o_bottom_sheet .o_crm_mobile_quick_create_title";
    const nameInput = "form.o_crm_mobile_quick_create input[name=name]";
    const save = ".o_crm_mobile_quick_create_save";
    await contains(".o_crm_mobile_pipeline_new").click();
    await contains(nameInput).edit("Rejected Lead", { confirm: false });
    await contains(save).click();
    expect(title).toBeFocused();

    // The user tabs to the name meanwhile: the failure re-enables Save without
    // taking the focus back to it.
    await press("Tab");
    expect(nameInput).toBeFocused();
    saveHeld.resolve();
    await animationFrame();
    await animationFrame();
    expect(save).toBeEnabled();
    expect(".o_dialog").toHaveCount(1);
    await contains(".o_dialog .btn-close").click();
    await animationFrame();
    expect(".o_dialog").toHaveCount(0);
    expect(".o_bottom_sheet form.o_crm_mobile_quick_create").toHaveCount(1);
    expect(nameInput).toBeFocused();
    expect.verifyErrors(["Invalid lead"]);
});

test.tags("mobile");
test("mobile pipeline Load more keeps the focus on the stage name while it loads", async () => {
    let holdLoadMore = null;
    onRpc("crm.lead", "web_search_read", () => holdLoadMore?.promise);
    await mountWithCleanup(WebClient);
    // Two leads loaded per stage: one of the three "New" leads is left to load.
    await openAction(LIMITED_ACTION_ID);
    const button = ".o_crm_mobile_pipeline_load_more button";
    const stageName = ".o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_stage_name";
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs"]);

    // While it loads, the button is disabled and busy, and the stage name holds
    // the focus; once loaded, the button is gone and the first loaded card takes it.
    holdLoadMore = Promise.withResolvers();
    await contains(button).click();
    expect(button).not.toBeEnabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(stageName).toBeFocused();
    holdLoadMore.resolve();
    holdLoadMore = null;
    await animationFrame();
    await animationFrame();
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(".o_crm_mobile_pipeline_load_more").toHaveCount(0);
    expect(`${card("Desk Upgrade")} .o_crm_mobile_lead_open`).toBeFocused();
});

// -----------------------------------------------------------------------------
// Lead form: its cached read after the replay of the lead's queued writes
// -----------------------------------------------------------------------------

/** Name of "Office Design" (lead 1) edited offline. */
const EDITED_NAME = "Office Design Ünïcode 東京";

/**
 * Records the `crm.lead` `web_read` calls the mock server receives (`receivedCalls`):
 * `calls` in arrival order, and `of(resId)` those of one lead.
 *
 * @returns {{calls: Object[], of: (resId: number) => Object[]}}
 */
function leadReads() {
    const calls = receivedCalls("crm.lead", "web_read");
    return { calls, of: (resId) => calls.filter(({ args }) => args[0][0] === resId) };
}

/**
 * Opens the lead form from its pipeline card, edits the lead and saves (offline:
 * queued), then goes back to the pipeline unless `stay`.
 *
 * @param {string} cardName
 * @param {Object<string, string>} values field name → typed value ("" clears)
 * @param {{stay?: boolean}} [options]
 */
async function editLeadForm(cardName, values, { stay = false } = {}) {
    await contains(`${card(cardName)} .o_crm_mobile_lead_open`).click();
    for (const [fieldName, value] of Object.entries(values)) {
        const input = `.o_field_widget[name=${fieldName}] input`;
        if (value) {
            await contains(input).edit(value);
        } else {
            await contains(input).clear();
        }
    }
    await contains(".o_form_button_save").click();
    if (!stay) {
        await contains(".o_back_button").click();
    }
}

/**
 * Values the lead form shows for its name, revenue, phone and email.
 *
 * @returns {string[]}
 */
function leadFormValues() {
    return ["name", "expected_revenue", "phone", "email_from"].map(
        (fieldName) => queryFirst(`.o_field_widget[name=${fieldName}] input`).value
    );
}

test.tags("mobile");
test("lead form reopened offline after a replayed edit shows the server values", async () => {
    expect.errors(6);
    let rpcCache = null;
    const { setCache } = rpc;
    patchWithCleanup(rpc, {
        setCache(cache) {
            rpcCache = cache;
            return setCache.call(this, cache);
        },
    });
    const reads = leadReads();
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    MockServer.env["crm.lead"].write([1], {
        phone: "+1 555 0100",
        email_from: "plain@example.com",
    });
    await openAction(ACTION_ID);
    await visitLead("Office Design");
    // The form's own cached read of the lead, with the phone variant (activity rows).
    const [formRead] = reads.of(1);
    expect(reads.of(1)).toHaveLength(1);
    expect(formRead.kwargs.specification).toInclude("activity_ids");

    // Offline: the lead is edited in its form, then the user goes back.
    await setOffline(true);
    await editLeadForm("Office Design", {
        name: EDITED_NAME,
        expected_revenue: "1234.56",
        phone: "",
        email_from: "",
    });
    expect(queued("crm.lead").map(({ method, args }) => [method, args])).toEqual([
        [
            "web_save",
            [
                [1],
                { name: EDITED_NAME, expected_revenue: 1234.56, phone: false, email_from: false },
            ],
        ],
    ]);

    // Once the edit is replayed, the cached read is requested again, exactly as the
    // form requested it, and only once.
    reads.calls.splice(0);
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(reads.calls).toEqual([formRead]);
    expect(MockServer.env["crm.lead"].browse(1)[0]).toMatchObject({
        name: EDITED_NAME,
        expected_revenue: 1234.56,
        phone: false,
        email_from: false,
    });
    await animationFrame(); // let the disk cache be written

    // Offline again, the form shows the server values: from the RAM cache, then from
    // the disk cache after a cold start.
    await setOffline(true);
    await contains(`${card(EDITED_NAME)} .o_crm_mobile_lead_open`).click();
    expect(leadFormValues()).toEqual([EDITED_NAME, "1,234.56", "", ""]);
    await contains(".o_back_button").click();
    rpcCache.ramCache.invalidate();
    await contains(`${card(EDITED_NAME)} .o_crm_mobile_lead_open`).click();
    expect(leadFormValues()).toEqual([EDITED_NAME, "1,234.56", "", ""]);
    // The framework's own cached loads offline (form, pipeline, form, pipeline, then
    // the form's views and root from the disk cache); the refresh adds none.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/get_views",
        "/web/dataset/call_kw/crm.lead/web_read",
    ]);
});

test.tags("mobile");
test("lead form displayed during a replay reloads its lead once", async () => {
    expect.errors(1);
    const reads = leadReads();
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();
    const [formRead] = reads.of(1);

    // Edited offline, the lead stays displayed while its save is replayed.
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit(EDITED_NAME);
    await contains(".o_form_button_save").click();
    reads.calls.splice(0);
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    // The form reloads its lead through its own request: no second read of it.
    expect(reads.calls).toEqual([formRead]);
    expect(".o_field_widget[name=name] input").toHaveValue(EDITED_NAME);

    // Leaving the form requests nothing more, and the lead reopened offline shows the
    // server values.
    reads.calls.splice(0);
    await contains(".o_back_button").click();
    expect(reads.calls).toEqual([]);
    await setOffline(true);
    await contains(`${card(EDITED_NAME)} .o_crm_mobile_lead_open`).click();
    expect(".o_field_widget[name=name] input").toHaveValue(EDITED_NAME);
    expect(reads.calls).toEqual([]);
    // The framework's own cached root load of the form reopened offline.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read"]);
});

test.tags("mobile");
test("lead form cached read waits for a sync ending online after a connection lost during the replay", async () => {
    expect.errors(5);
    const reads = leadReads();
    const setOffline = mockOffline();
    const drops = dropConnections();
    // The replay of lead 1's save is followed by a lost connection.
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (args[0][0] === 1) {
            drops.add("crm.lead/web_save");
        }
    });
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await visitLead("Office Design");
    await visitLead("Quote for Chairs");
    const [formRead1] = reads.of(1);
    const [formRead2] = reads.of(2);

    await setOffline(true);
    await editLeadForm("Office Design", { name: EDITED_NAME });
    await editLeadForm("Quote for Chairs", { name: "Chairs (offline)" });
    reads.calls.splice(0);

    // The replay delivers lead 1's save, then the connection drops: the sync ends
    // offline and no read is requested.
    await setOffline(false);
    const plugin = getService(OfflinePlugin);
    for (let i = 0; i < 5 && plugin.syncingORM(); i++) {
        await advanceTime(1000);
    }
    await animationFrame();
    expect(plugin.isOffline()).toBe(true);
    expect(queued("crm.lead").map(({ args }) => args[0])).toEqual([[2]]);
    expect(MockServer.env["crm.lead"].browse(1)[0].name).toBe(EDITED_NAME);
    expect(reads.calls).toEqual([]);

    // The next sync ends online: both leads' cached reads are requested again.
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(reads.calls).toEqual([formRead1, formRead2]);
    await setOffline(true);
    await contains(`${card(EDITED_NAME)} .o_crm_mobile_lead_open`).click();
    expect(".o_field_widget[name=name] input").toHaveValue(EDITED_NAME);
    // The framework's own cached root loads offline (two edits, then the reopened form).
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read",
    ]);
});

test.tags("mobile");
test("lead form kept on its lead by a parked call refreshes the lead's cached read once left", async () => {
    expect.errors(1);
    onRpc("crm.lead", "action_set_won", () => {
        throw makeServerError({ message: "Won refused" });
    });
    const reads = leadReads();
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(BUTTONS_ACTION_ID);
    await contains(`${card("Office Design")} .o_crm_mobile_lead_open`).click();
    const [formRead] = reads.of(1);

    // Offline: an edit, then "Won", whose replay is rejected (parked).
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit(EDITED_NAME);
    await contains(".o_form_button_save").click();
    await contains("button[name=action_set_won_rainbowman]").click();
    expect(queued("crm.lead").map(({ method }) => method)).toEqual(["web_save", "action_set_won"]);
    reads.calls.splice(0);
    await reconnect(setOffline);
    expect(queued("crm.lead").map(({ method }) => method)).toEqual(["action_set_won"]);

    // A parked call keeps the form on the lead's local state, without a reload: the
    // read it displays, stale since the replay, is requested once the form is left.
    // Either way, it is requested once.
    await contains(".o_back_button").click();
    expect(reads.calls).toEqual([formRead]);
    expect(".o_error_dialog").toHaveCount(0);

    // Offline, the lead reopened shows the replayed edit.
    await setOffline(true);
    await contains(`${card(EDITED_NAME)} .o_crm_mobile_lead_open`).click();
    expect(".o_field_widget[name=name] input").toHaveValue(EDITED_NAME);
    expect(reads.calls).toEqual([formRead]);
    // The framework's own cached root load of the form reopened offline.
    expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read"]);
});

test.tags("mobile");
test("lead form read refresh is retried after a lost connection, not after a server error", async () => {
    expect.errors(4);
    const reads = leadReads();
    const setOffline = mockOffline();
    const drops = dropConnections();
    // Registered after `dropConnections`: it also sees the dropped requests.
    const calls = trackCalls();
    const leadReadRequests = () => calls.filter((call) => call === "crm.lead/web_read");
    let rejectRead2 = false;
    // Registered after `leadReads`, so it runs first: the rejected read is not recorded.
    onRpc("crm.lead", "web_read", ({ args }) => {
        if (rejectRead2 && args[0][0] === 2) {
            rejectRead2 = false;
            throw makeServerError({ message: "Lead no longer readable" });
        }
    });
    // After the last replayed save, the next lead read (lead 1's refresh) is dropped,
    // and the server rejects lead 2's.
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (args[0][0] === 2) {
            drops.add("crm.lead/web_read");
            rejectRead2 = true;
        }
    });
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await visitLead("Office Design");
    await visitLead("Quote for Chairs");
    const [formRead1] = reads.of(1);

    await setOffline(true);
    await editLeadForm("Office Design", { name: EDITED_NAME });
    await editLeadForm("Quote for Chairs", { name: "Chairs (offline)" });
    reads.calls.splice(0);
    calls.splice(0);
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    // Once the connection is back (at the latest at the next reconnection), lead 1's
    // read is requested again; lead 2's is not.
    await reconnect(setOffline);
    expect(leadReadRequests()).toHaveLength(3);
    expect(reads.calls).toEqual([formRead1]);

    // Neither read is stale anymore: a later sync requests none.
    calls.splice(0);
    await setOffline(true);
    await reconnect(setOffline);
    expect(leadReadRequests()).toEqual([]);
    expect(".o_error_dialog").toHaveCount(0);
    // The framework's own cached root loads offline (two edits).
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("mobile");
test("lead form read refresh answered after a later replayed write of its lead is requested again, once", async () => {
    expect.errors(4);
    // While `held` is set, each lead read is answered from the server state of its
    // arrival, once its deferred is resolved. Registered before `leadReads`, which
    // then records the held reads too.
    let held = null;
    onRpc("crm.lead", "web_read", async ({ parent }) => {
        if (held) {
            const result = await parent();
            const deferred = Promise.withResolvers();
            held.push({ result, deferred });
            await deferred.promise;
            return result;
        }
    });
    const reads = leadReads();
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await openAction(ACTION_ID);
    await visitLead("Office Design");
    const [formRead] = reads.of(1);
    const plugin = getService(OfflinePlugin);

    // Offline: two writes of the lead, its form's save (name), then its card's stage
    // move; the lead is then displayed in its form again, in its new stage.
    await setOffline(true);
    await editLeadForm("Office Design", { name: EDITED_NAME });
    await contains(`${card(EDITED_NAME)} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    const writes = queued("crm.lead");
    expect(writes.map(({ method, args }) => [method, args])).toEqual([
        ["web_save", [[1], { name: EDITED_NAME }]],
        ["web_save", [[1], { stage_id: QUALIFIED }]],
    ]);
    expect(writes[0].extras.timeStamp).toBeLessThan(writes[1].extras.timeStamp);
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(`${card(EDITED_NAME)} .o_crm_mobile_lead_open`).click();
    expect(".o_field_widget[name=name] input").toHaveValue(EDITED_NAME);

    // The save is replayed; before the move's replay a second later, the form is left:
    // its read, stale since the save's replay, is requested again and held, answered
    // with the server state from before the move.
    reads.calls.splice(0);
    await setOffline(false);
    for (let i = 0; i < 10 && queued("crm.lead").length > 1; i++) {
        await animationFrame();
    }
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([writes[1].key]);
    held = [];
    await contains(".o_back_button").click();
    expect(reads.calls).toEqual([formRead]);
    expect(held).toHaveLength(1);
    const [heldRead] = held;
    held = null;
    expect(heldRead.result[0].name).toBe(EDITED_NAME);
    expect(heldRead.result[0].stage_id.id).toBe(NEW);

    // The move is replayed and the sync ends online while that read runs: nothing
    // more is requested yet.
    for (let i = 0; i < 5 && plugin.syncingORM(); i++) {
        await advanceTime(1000);
    }
    await animationFrame();
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(plugin.isOffline()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0]).toMatchObject({
        name: EDITED_NAME,
        stage_id: QUALIFIED,
    });
    expect(reads.calls).toEqual([formRead]);

    // The held read ends: its lead's read is requested again, once, after the move.
    heldRead.deferred.resolve();
    await animationFrame();
    await animationFrame();
    expect(reads.calls).toEqual([formRead, formRead]);
    await advanceTime(1000);
    await animationFrame();
    expect(reads.calls).toHaveLength(2);

    // Offline, the lead reopened in its new stage (the stage the pipeline was left
    // at) shows the values of both writes, as the server holds them, and nothing more
    // is requested.
    await setOffline(true);
    expect(headerTexts()[0]).toBe("Qualified");
    await contains(`${card(EDITED_NAME)} .o_crm_mobile_lead_open`).click();
    expect(".o_field_widget[name=name] input").toHaveValue(EDITED_NAME);
    expect(STAGE_DROPDOWN_TOGGLE).toHaveText("Qualified");
    expect(reads.calls).toHaveLength(2);
    // The framework's own cached root loads offline (the edit, the form reopened
    // before the replay, then after it).
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read",
    ]);
});

// -----------------------------------------------------------------------------
// Desktop
// -----------------------------------------------------------------------------

test.tags("desktop");
test("crm_mobile_pipeline renders the standard kanban on desktop", async () => {
    const specs = rootSpecs();
    const calls = trackCalls();
    await mountWithCleanup(WebClient);

    /**
     * Opens a kanban action and returns its renderer DOM and its root request.
     *
     * @param {number} actionId
     */
    const visit = async (actionId) => {
        const loadCount = specs.length;
        await openAction(actionId);
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
        const rootLoads = specs
            .slice(loadCount)
            .filter(({ method }) => method === "web_read_group");
        expect(rootLoads).toHaveLength(1);
        // Datapoint ids are generated per load: the rest of the markup is compared.
        const html = queryFirst(".o_kanban_renderer").outerHTML.replace(
            /datapoint_\d+/g,
            "datapoint"
        );
        return { html, rootLoad: rootLoads[0] };
    };

    // Opportunities pipeline arch, then grouped Leads arch: each against `crm_kanban`.
    for (const [actionId, referenceActionId] of [
        [ACTION_ID, DESKTOP_ACTION_ID],
        [LEADS_ACTION_ID, DESKTOP_LEADS_ACTION_ID],
    ]) {
        const reference = await visit(referenceActionId);
        const pipeline = await visit(actionId);
        expect(pipeline.html).toBe(reference.html);
        expect(pipeline.rootLoad.specification).toEqual(reference.rootLoad.specification);
        expect(pipeline.rootLoad.aggregates).toEqual(reference.rootLoad.aggregates);
    }
    expect(calls.filter((call) => call.startsWith("mail.activity"))).toEqual([]);
});

test.tags("desktop");
test("crm_mobile_pipeline on desktop sends the crm_kanban root requests offline after Load more", async () => {
    expect.errors(4);
    const setOffline = mockOffline();
    const requests = rootRequests();
    await makeMockServer();
    // 83 leads in "New", 80 of them (the action's limit) loaded at first.
    addLeads(NEW, 80, "New lead");
    await mountWithCleanup(WebClient);

    /**
     * Opens a kanban action and visits "Office Design", loads the rest of "New" with
     * "Load more", then, offline, opens that lead's cached form and goes back, and
     * reconnects. Returns the root requests sent offline and once reconnected, and
     * the content shown after going back.
     *
     * @param {number} actionId
     */
    const visit = async (actionId) => {
        await openAction(actionId);
        await contains(".o_kanban_record:contains(Office Design)").click();
        await contains(".o_back_button").click();
        await contains(".o_kanban_group:first .o_kanban_load_more button").click();
        expect(".o_kanban_group:first .o_kanban_record").toHaveCount(83);
        await setOffline(true);
        const offlineStart = requests.length;
        await contains(".o_kanban_record:contains(Office Design)").click();
        expect(".o_form_view").toHaveCount(1);
        await contains(".o_back_button").click();
        await animationFrame();
        const offline = requests.slice(offlineStart);
        const helper = queryAll(".o_kanban_view .o_view_nocontent .fa-chain-broken").length;
        const renderers = queryAll(".o_kanban_renderer").length;
        await setOffline(false);
        await animationFrame();
        await animationFrame();
        const online = requests.slice(offlineStart + offline.length);
        return { offline, online, helper, renderers };
    };

    // `crm_kanban`, then `crm_mobile_pipeline`, on the same pipeline arch.
    const reference = await visit(DESKTOP_ACTION_ID);
    expect(reference).toEqual({ offline: [[true, false]], online: [], helper: 1, renderers: 0 });
    expect(await visit(ACTION_ID)).toEqual(reference);
    // The framework's cached form load and its root load that could not be served,
    // for each view.
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
        "/web/dataset/call_kw/crm.lead/web_read",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
});

test.tags("desktop");
test("crm_mobile_pipeline on desktop reads no stage choices, ungrouped or grouped", async () => {
    const stageGroups = expandStageChoices();
    const calls = trackCalls();
    // The ungrouped Leads arch renders the standard kanban, with the requests of
    // `crm_kanban` only.
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    await animationFrame();
    expect(".o_kanban_renderer .o_kanban_record:not(.o_kanban_ghost)").toHaveCount(7);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    // The grouped pipeline arch: the standard columns, likewise.
    await mountPipeline();
    await animationFrame();
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(calls.filter((call) => call.endsWith("/formatted_read_group"))).toEqual([]);
    expect(stageGroups).toEqual([]);
});

test.tags("desktop");
test("crm_mobile_pipeline keeps the kanban card keyboard navigation on desktop", async () => {
    await mountPipeline();
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    const [newCards, qualifiedCards] = queryAll(".o_kanban_renderer .o_kanban_group").map(
        (group) => [...group.querySelectorAll(".o_kanban_record")]
    );
    expect(newCards).toHaveLength(3);

    await contains(newCards[0]).focus();
    const down = (await press("ArrowDown")).get("keydown");
    await animationFrame();
    // Handled by the kanban card hotkey, which prevents the browser's default.
    expect(down.defaultPrevented).toBe(true);
    expect(newCards[1]).toBeFocused();
    await press("ArrowRight");
    await animationFrame();
    expect(qualifiedCards[0]).toBeFocused();
    await press("ArrowLeft");
    await animationFrame();
    expect(newCards[0]).toBeFocused();
});

test.tags("desktop");
test("lead form on desktop keeps its specification and has no activities button", async () => {
    const specs = [];
    onRpc("crm.lead", "web_read", ({ kwargs }) => {
        specs.push(kwargs.specification);
    });
    const calls = trackCalls();
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        arch: leadFormArch,
        config: { actionId: ACTION_ID },
    });
    expect(".o_form_view").toHaveCount(1);
    expect(".o_crm_mobile_activities_button").toHaveCount(0);
    expect(specs).toHaveLength(1);
    expect(specs[0]).not.toInclude("activity_ids");

    // The same arch without the CRM form `js_class`: the same specification.
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        arch: leadFormArch.replace(' js_class="crm_form"', ""),
    });
    expect(specs).toHaveLength(2);
    expect(specs[0]).toEqual(specs[1]);
    expect(".o_crm_mobile_activities_button").toHaveCount(0);
    expect(calls.filter((call) => call.startsWith("mail.activity"))).toEqual([]);
});

test.tags("desktop");
test("New Lead deep-link flag is ignored on desktop", async () => {
    patchWithCleanup(quickCreateDeepLink, { pending: true });
    await mountWithCleanup(WebClient);

    // "New Lead" launched on a wide screen: the standard kanban, with no sheet. The
    // flag belongs to the launch: this first pipeline mount takes it.
    await openAction(ACTION_ID);
    await animationFrame();
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(".o_crm_mobile_quick_create").toHaveCount(0);
    expect(".o_kanban_quick_create").toHaveCount(0);
    expect(quickCreateDeepLink.pending).toBe(false);

    // Later in the same page load, at phone size, no sheet opens: neither when the
    // pipeline turns small nor when it opens again after another view.
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    expect(".o_bottom_sheet").toHaveCount(0);
    await getService("action").doAction(
        {
            type: "ir.actions.act_window",
            res_model: "crm.lead",
            res_id: 1,
            views: [[false, "form"]],
        },
        { clearBreadcrumbs: true }
    );
    expect(".o_form_view").toHaveCount(1);
    await openAction(ACTION_ID);
    await animationFrame();
    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(".o_crm_mobile_quick_create").toHaveCount(0);
});

test.tags("desktop");
test("crm_mobile_pipeline leaves the kanban's global state unchanged on desktop", async () => {
    /** Keys of the action's global state once a lead is opened from its kanban. */
    const globalStateKeys = async (actionId) => {
        await openAction(actionId);
        await contains(".o_kanban_record:contains(Lamps)").click();
        expect(".o_form_view").toHaveCount(1);
        return Object.keys(getService("action").currentController.action.globalState);
    };
    await mountWithCleanup(WebClient);
    const reference = await globalStateKeys(DESKTOP_ACTION_ID);
    expect(await globalStateKeys(ACTION_ID)).toEqual(reference);
    expect(reference).not.toInclude("crmMobilePipeline");
});
