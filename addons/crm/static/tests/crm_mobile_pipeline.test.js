/**
 * Mobile lane of the CRM offline work: the `crm_mobile_pipeline` kanban view
 * (`CrmMobilePipelineController` and its `CrmMobilePipeline` renderer), the
 * mobile lead card (`CrmMobileLeadCard`), its activity bottom sheet
 * (`CrmMobileLeadActivities`), the bottom-sheet quick create
 * (`CrmMobileQuickCreate`) and the shared `useCrmOffline()` hooks.
 *
 * Every pipeline, card, sheet and quick-create test mounts the real view through
 * its `js_class` (`mountView` with `js_class="crm_mobile_pipeline"`, or the web
 * client with an action), never a component on its own, so the registry entry,
 * the controller, the renderer and the renderer's `static components` all run on
 * their real parent path. The lead form tests mount `js_class="crm_form"`.
 *
 * Queue assertions read genuine entries of the framework queue, created by the
 * code under test (offline saves, quick creates, the activity sheet); parked
 * entries come from the mock server rejecting a replay. Errors the framework's
 * own cached root loads raise offline are declared with `expect.errors()` and
 * `expect.verifyErrors()`; CRM code adds none. The online tests declare the same
 * way the server rejections they inject, and simulate a connection lost during
 * one request with a 502 answer to that request only (`dropConnections`).
 *
 * Mobile tests run in the mobile preset (375x667, touch); the three desktop
 * checks run in the desktop preset.
 */

import { beforeEach, expect, test } from "@odoo/hoot";
import {
    advanceTime,
    animationFrame,
    manuallyDispatchProgrammaticEvent,
    press,
    queryAll,
    queryAllTexts,
    queryFirst,
    resize,
} from "@odoo/hoot-dom";
import { mockDate } from "@odoo/hoot-mock";
import { mailModels } from "@mail/../tests/mail_test_helpers";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    makeMockServer,
    makeServerError,
    mockOffline,
    MockServer,
    models,
    mountView,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    serverState,
} from "@web/../tests/web_test_helpers";
import { defineCrmModels } from "@crm/../tests/crm_test_helpers";
import { quickCreateDeepLink } from "@crm/mobile/crm_offline_hooks";
import { AutoComplete } from "@web/core/autocomplete/autocomplete";
import { rpc } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
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

beforeEach(() => {
    patchWithCleanup(AnimatedNumber, { enableAnimations: false });
    // Job-scoped changes of the shared mail mocks (reset after each test).
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
// Arches (the two CRM lead kanban arches and the lead form, after their in-place
// edits: mobile `js_class` and the Call activity type option)
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

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

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
 * Restores the connection and waits until the framework has replayed every
 * queued call that is not parked, then lets the views reconcile.
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
test("mobile pipeline falls back to the desktop variant offline after a wide-layout visit", async () => {
    expect.errors(1);
    const setOffline = mockOffline();
    // Visited online at desktop size only.
    await resize({ width: 1366, height: 768 });
    await mountWithCleanup(WebClient);
    await openAction(LEADS_ACTION_ID);
    expect(".o_kanban_group").toHaveCount(3);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);

    // Offline on a small screen, the pipeline is mounted again with the mobile
    // variant, which was never cached: it is served the desktop variant instead.
    // (Mounting a new view offline would need the small-screen view description,
    // which the framework caches per screen size: the mounted view is reused.)
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

    // The activity sheet lists the next activity, whose "Mark done" works.
    await openActivities("Office Design");
    expect(activityTitles()).toEqual(["Follow-up call"]);
    expect(".o_crm_mobile_activities_more").toHaveText("1 more activities after sync");
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
    patchWithCleanup(quickCreateDeepLink, { pending: true });
    await openAction(ACTION_ID);
    await animationFrame(); // the sheet opens once the pipeline is mounted
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
test("mobile pipeline lists ungrouped leads with the stages they show", async () => {
    const setOffline = mockOffline();
    const specs = rootSpecs();
    await mountPipeline({ arch: leadsArch, groupBy: [] });
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
    // The stage choices are the distinct stages of the loaded leads.
    expect(queryAllTexts(`${card("Lamps")} .o_crm_mobile_lead_stage option`)).toEqual([
        "New",
        "Qualified",
        "Won",
    ]);
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
    // The stage selector lists the pipeline stages, on the lead's own.
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
        expect(Math.round(width) >= TOUCH_TARGET && Math.round(height) >= TOUCH_TARGET).toBe(true, {
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
test("mobile lead card stage move queues offline", async () => {
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

    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "4", "$ 1,000"]);
    expect(cardNames()).toEqual(["Desk Upgrade", "Conference Room", "Lamps", "Storage Racks"]);
    expect(`${card("Desk Upgrade")} .o_crm_mobile_lead_stage`).toHaveValue(String(QUALIFIED));
    expect(textOf(`${card("Desk Upgrade")} .o_crm_mobile_pending_sync`)).toBe("Pending sync");
    // Only the framework's record save, which tries the server before queueing the
    // call on the lost connection: no rainbowman lookup, no other request.
    expect(calls).toEqual(["crm.lead/web_save"]);
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
    // Nothing else to fill in: exactly the six fields.
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
    // The stage selector lists the pipeline stages, on the displayed one.
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
    expect(queued("crm.lead")).toEqual([]);

    // Typing clears the flag.
    await contains("form.o_crm_mobile_quick_create input[name=name]").edit("Draft", {
        confirm: false,
    });
    expect("form.o_crm_mobile_quick_create input[name=name]").not.toHaveClass("is-invalid");
    expect(".o_crm_mobile_quick_create .invalid-feedback").toHaveCount(0);

    // Cancel closes the sheet without saving.
    await contains(".o_crm_mobile_quick_create_cancel").click();
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_crm_mobile_lead_card_provisional").toHaveCount(0);
    expect(headerTexts()).toEqual(["New", "3", "$ 600"]);
});

test.tags("mobile");
test("mobile quick create queues a create offline in two cached stages without an online create", async () => {
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
    expect(creates[0].args[1]).toEqual({
        name: "Lead in New",
        contact_name: "Ann Buyer",
        phone: "+32 470 12 34 56",
        email_from: "ann@example.com",
        expected_revenue: 120,
        stage_id: NEW,
    });
    expect(creates[1].args[1]).toEqual({
        name: "Lead in Qualified",
        contact_name: "",
        phone: "",
        email_from: "",
        expected_revenue: 80,
        stage_id: QUALIFIED,
    });

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
});

/** The values the quick-create sheet saves for a lead with a name and revenue only. */
function quickCreateValues(name, revenue) {
    return {
        name,
        contact_name: "",
        phone: "",
        email_from: "",
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

    // A server error on that reload is not a lost connection: it reaches the error
    // handling and the sheet keeps its values, the lead being created on the server.
    await reconnect(setOffline);
    failRootReload = true;
    await quickCreateLead({ name: "Reloaded Lead", revenue: 6 });
    await animationFrame();
    expect(failRootReload).toBe(false);
    expect(MockServer.env["crm.lead"].search_count([["name", "=", "Reloaded Lead"]])).toBe(1);
    expect(queued("crm.lead")).toEqual([]);
    expect("form.o_crm_mobile_quick_create input[name=name]").toHaveValue("Reloaded Lead");
    expect.verifyErrors(["Pipeline reload failed"]);
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

    // Reconnected: the replay ends with the sheet still open.
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
    // The new row's done button works online.
    await contains(`${activityRow(newActivity.id)} .o_crm_mobile_activity_done`).click();
    expect(activityRow(newActivity.id)).toHaveCount(0);
    expect(activityTitles()).toEqual(["Follow-up call", "Rejected visit"]);
});

test.tags("mobile");
test("mobile activities: log a call queues the Call type offline and shows pending", async () => {
    mockDate("2026-10-02 10:00:00");
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
    expect(create.args).toEqual([
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
    ]);
    // The user context: no default of the lead action becomes an activity default.
    expect(create.kwargs.context.uid).toBe(serverState.userId);
    expect(create.kwargs.context.default_type).toBe(undefined);
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_title").toHaveText("Call");
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_type_label").toHaveText("Call");
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_deadline").toHaveText(
        "10/02/2026"
    );
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_pending_sync").toHaveText("Pending sync");
    expect(".o_crm_mobile_activity_pending .o_crm_mobile_activity_done").toHaveCount(0);
    expect(calls).toEqual([]);
});

test.tags("mobile");
test("mobile activities: schedule follow-up queues offline and shows pending", async () => {
    mockDate("2026-10-02 10:00:00");
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
    expect(create.args[0][0]).toEqual({
        res_model: "crm.lead",
        res_id: 4,
        activity_type_id: 28,
        summary: "Send the contract",
        date_deadline: "2026-10-03",
        user_id: serverState.userId,
    });
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
});

test.tags("mobile");
test("mobile activities: mark done queues action_done offline and the list updates after replay", async () => {
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
    expect(calls).toEqual([]);

    // After the replay, the done activity has left the list (sheet still open).
    await reconnect(setOffline);
    expect(queued("mail.activity")).toEqual([]);
    expect(MockServer.env["mail.activity"].search_read([["id", "=", 1]], ["id"])).toEqual([]);
    expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
    expect(activityTitles()).toEqual(["Send brochure"]);
    expect(activityRow(1)).toHaveCount(0);
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
    await closeSheet();

    // Cached types without the Call type: scheduling works, "Log a call" does not.
    warmUp.resolve();
    await animationFrame();
    expect(await cachedActivityTypeIds()).toEqual([1, 28]);
    await openActivities("Office Design");
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").toBeEnabled();
    await contains(".o_crm_mobile_schedule_followup").click();
    expect(queryAllTexts(".o_crm_mobile_activity_type option")).toEqual([
        "Email",
        "Upload Document",
    ]);
    expect(queued("mail.activity")).toEqual([]);
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
    // connection: it reaches the error handling, the write stands, nothing is
    // queued and the form stays open.
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
    expect(queued("mail.activity")).toEqual([]);
    expect(".o_crm_mobile_activity_form").toHaveCount(1);
    expect.verifyErrors(["Lead reload failed"]);
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

    // Replayed once reconnected.
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

    // A name no cached partner matches: no create option.
    await searchPartner("Nobody");
    expect(queryAllTexts(".o-autocomplete--dropdown-item")).toEqual(["No records"]);
    for (const option of NON_RECORD_OPTIONS) {
        expect(option).toHaveCount(0);
    }

    // A cached name: the partner is offered and selected.
    await searchPartner("Deco");
    expect(queryAllTexts(".o-autocomplete--dropdown-item")).toEqual(["Deco Addict"]);
    for (const option of NON_RECORD_OPTIONS) {
        expect(option).toHaveCount(0);
    }
    await contains(".o-autocomplete--dropdown-item:contains(Deco Addict)").click();
    expect(PARTNER_INPUT).toHaveValue("Deco Addict");
    expect(".modal").toHaveCount(0);

    // Saved offline with the selected partner.
    await contains(".o_form_button_save").click();
    const [save] = queued("crm.lead");
    expect(save.args[0]).toEqual([2]);
    expect(save.args[1].partner_id).toBe(102);

    // No request reached the server. The attempts the lost network refused are the
    // framework's own: its record search, which falls back to the cached partners,
    // and its record save, which queues the call. No `name_search`, no select-create
    // dialog, no enrichment lookup.
    expect(serverCalls).toEqual([]);
    expect(
        attempts.filter(
            (call) => !["res.partner/web_name_search", "crm.lead/web_save"].includes(call)
        )
    ).toEqual([]);
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

    let calls = [];
    /** Opens the dropdown online with "Az", then disconnects with it open. */
    const openOnlineThenDisconnect = async () => {
        await setOffline(false);
        await searchPartner("Az");
        expect(queryAllTexts(".o-autocomplete--dropdown-item")).toEqual([
            "Azure Interior",
            'Create "Az"',
            "Create and edit...",
            "Search more...",
        ]);
        await setOffline(true);
        calls = trackCalls();
        // The options loaded online are still displayed.
        expect(".o-autocomplete--dropdown-item").toHaveCount(4);
    };
    /** Nothing happened: no request, no dialog, no partner, nothing queued. */
    const expectNothingHappened = () => {
        expect(calls).toEqual([]);
        expect(".modal").toHaveCount(0);
        expect(queued("crm.lead")).toEqual([]);
        expect(queued("res.partner")).toEqual([]);
    };

    // Clicked.
    for (const option of NON_RECORD_OPTIONS) {
        await openOnlineThenDisconnect();
        await contains(`.o-autocomplete--dropdown-item${option}`).click();
        await animationFrame();
        expectNothingHappened();
    }

    // Chosen with the keyboard (Enter on the active option).
    for (const [index, option] of NON_RECORD_OPTIONS.entries()) {
        await openOnlineThenDisconnect();
        for (let i = 0; i <= index; i++) {
            await press("ArrowDown");
        }
        await animationFrame();
        expect(`.o-autocomplete--dropdown-item${option} .ui-state-active`).toHaveCount(1);
        await press("Enter");
        await animationFrame();
        expectNothingHappened();
    }

    // Called directly.
    await openOnlineThenDisconnect();
    const partnerAutocomplete = autocompletes.findLast((autocomplete) =>
        autocomplete.inputRef()?.closest(".o_field_widget[name=partner_id]")
    );
    const staleOptions = partnerAutocomplete.sources
        .flatMap((source) => source.options)
        .filter((option) => !option.data?.record);
    expect(staleOptions).toHaveLength(3);
    for (const option of staleOptions) {
        expect(option.onSelect()).toBe(undefined);
    }
    await animationFrame();
    expectNothingHappened();
    // The field's own "Search more" and barcode entry points do nothing either.
    const partnerField = relationalAutocompletes.findLast((autocomplete) =>
        autocomplete.autocompleteContainerRef()?.closest(".o_field_widget[name=partner_id]")
    );
    await partnerField.onSearchMore("Az");
    await partnerField.onBarcodeSearch();
    await animationFrame();
    expectNothingHappened();

    // The record option stays usable, and on the phone the field searches inline.
    await contains(".o-autocomplete--dropdown-item:contains(Azure Interior)").click();
    expect(PARTNER_INPUT).toHaveValue("Azure Interior");
    // Online again, "Search more..." opens its dialog as before.
    await setOffline(false);
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
    await mountPipeline();
    await animationFrame();
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(".o_crm_mobile_quick_create").toHaveCount(0);
    expect(".o_kanban_quick_create").toHaveCount(0);
    // Left for a later phone pipeline of the same page load.
    expect(quickCreateDeepLink.pending).toBe(true);
});
