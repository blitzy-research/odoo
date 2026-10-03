/**
 * Tests of the CRM mobile pipeline. They mount the real `crm_mobile_pipeline` view
 * registration (and `crm_form` for the lead form) and cover the pipeline, the lead
 * card, its activity sheet and the quick create. Queue and replay assertions read
 * genuine framework queue entries and their replays. The framework's expected
 * cached-root-load fallback errors and the injected server errors are declared with
 * `expect.errors()` and `expect.verifyErrors()`. Mobile tests run in the mobile
 * preset; the three desktop checks run in the desktop preset.
 */

import { after, beforeEach, expect, mockDate, test } from "@odoo/hoot";
import {
    advanceTime,
    animationFrame,
    manuallyDispatchProgrammaticEvent,
    press,
    queryAll,
    queryAllTexts,
    queryFirst,
    resize,
    runAllTimers,
    waitFor,
} from "@odoo/hoot-dom";
import { onWillDestroy, onWillPatch, toRaw } from "@odoo/owl";
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
import {
    CrmMobileLeadActivities,
    CrmMobileLeadCard,
} from "@crm/mobile/crm_mobile_lead_card/crm_mobile_lead_card";
import {
    CrmMobilePipeline,
    CrmMobilePipelineController,
} from "@crm/mobile/crm_mobile_pipeline/crm_mobile_pipeline";
import { isQuickCreateDeepLink, quickCreateDeepLink } from "@crm/mobile/crm_offline_hooks";
import { CrmFormController } from "@crm/views/crm_form/crm_form";
import { AutoComplete } from "@web/core/autocomplete/autocomplete";
import { browser } from "@web/core/browser/browser";
import { getCurrency } from "@web/core/currency";
import { rpc } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { formatMonetary } from "@web/views/fields/formatters";
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
    // No lead is loaded, so the revenue has no currency to show.
    expect(headerTexts()).toEqual(["New", "0", "0"]);
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(ROOT_HELPER).toHaveCount(1);
    expect(ROOT_HELPER).toHaveText(/No data to display/);

    // Offline create: the provisional card shows without the helper, in every stage.
    await setOffline(true);
    await quickCreateLead({ name: "Offline Lead", revenue: 50 });
    expect(cardNames()).toEqual(["Offline Lead"]);
    expect(".o_crm_mobile_lead_card_provisional").toHaveCount(1);
    expect(headerTexts()).toEqual(["New", "1", "50"]);
    expect(".o_view_nocontent").toHaveCount(0);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(headerTexts()).toEqual(["Qualified", "0", "0"]);
    expect(".o_crm_mobile_lead_card").toHaveCount(0);
    expect(".o_view_nocontent").toHaveCount(0);
    await contains(".o_crm_mobile_pipeline_prev").click();

    // Discarded in the offline systray: empty again (cached reload), with the helper.
    await contains("div.o_nav_entry.o_offline_systray").click();
    await contains(".o-dropdown--menu button[title='Discard offline changes']").click();
    await contains(".modal-dialog .modal-footer button.btn-primary").click();
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(headerTexts()).toEqual(["New", "0", "0"]);
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
    expect(headerTexts()).toEqual(["New", "1", "50"]);
    expect(".o_view_nocontent").toHaveCount(0);
    expect(".o_crm_mobile_lead_card_provisional").toHaveCount(1);
    expect(queued("crm.lead").map(({ method, args }) => ({ method, args }))).toEqual([
        {
            method: "web_save",
            args: [
                [],
                {
                    name: "Offline Lead",
                    contact_name: "",
                    phone: "",
                    email_from: "",
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
test("mobile pipeline reconnected on a wide screen leaves the desktop fallback without a reload", async () => {
    expect.errors(2);
    const setOffline = mockOffline();
    const specs = rootSpecs();
    const rootLoads = () => specs.filter(({ method }) => method === "web_read_group");
    // Visited online at desktop size: the desktop variant is cached.
    await resize({ width: 1366, height: 768 });
    await mountPipeline({ arch: plainPipelineArch });
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);
    expect(rootLoads()).toHaveLength(1);

    // Offline on a phone, the never-cached mobile variant falls back to the cached
    // desktop one.
    await setOffline(true);
    const calls = trackCalls();
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    expect(cardNames()).toEqual(["Office Design", "Quote for Chairs", "Desk Upgrade"]);
    expect(headerTexts()).toEqual(["New", "3", null]);

    // Widened while still offline: the desktop kanban, from the cache.
    await resize({ width: 1366, height: 768 });
    await animationFrame();
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);

    // Reconnected on the wide screen: the fallback ends, and no root load is issued.
    calls.splice(0);
    const loadCount = rootLoads().length;
    await reconnect(setOffline);
    expect(calls.filter((call) => call.startsWith("crm.lead/"))).toEqual([]);
    expect(rootLoads()).toHaveLength(loadCount);
    expect(".o_kanban_renderer .o_kanban_group").toHaveCount(3);

    // Back on a phone, online: one root load, with the mobile variant.
    await resize({ width: 375, height: 667 });
    await animationFrame();
    expect(rootLoads()).toHaveLength(loadCount + 1);
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

    // An offline stage change: the region reads "Pending sync", like the visible
    // badge, which assistive technology skips so that it is not read twice.
    await setOffline(true);
    await contains(`${card("Lamps")} .o_crm_mobile_lead_stage`).select(String(NEW));
    expect(status("Lamps")).toHaveText("Pending sync");
    expect(badge("Lamps")).toHaveText("Pending sync");
    expect(badge("Lamps")).toHaveAttribute("aria-hidden", "true");
    expect(status("Storage Racks")).toHaveText("");

    // Rejected on replay, the write is parked: the region reads "Sync failed".
    await reconnect(setOffline);
    const [parked] = queued("crm.lead");
    expect(parked.args[0]).toEqual([5]);
    expect(parked.extras.error).toInclude("Stage is locked");
    expect(status("Lamps")).toHaveText("Sync failed");
    expect(badge("Lamps")).toHaveText("Sync failed");
    expect(badge("Lamps")).toHaveAttribute("aria-hidden", "true");
    expect(".o_crm_mobile_lead_card .o_crm_mobile_lead_sync_status[role=status]").toHaveCount(7);
    expect(status("Storage Racks")).toHaveText("");
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
    // `default_stage_id` the framework gives the stage group the lead was loaded in.
    const moveCall = {
        model: "crm.lead",
        method: "web_save",
        args: [[3], { stage_id: QUALIFIED }],
        kwargs: {
            context: { ...user.context, ...PIPELINE_CONTEXT, default_stage_id: NEW },
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
    // An existing stage no loaded lead has: the ungrouped list does not offer it.
    const proposalId = MockServer.env["crm.stage"].create({ name: "Proposal", sequence: 4 });
    const setOffline = mockOffline();
    await mountPipeline({ arch: leadsArch, groupBy: [] });
    const calls = trackCalls();
    const select = `${card("Lamps")} .o_crm_mobile_lead_stage`;
    const badge = `${card("Lamps")} .o_crm_mobile_pending_sync`;
    const serverStage = () =>
        MockServer.env["crm.lead"].search_read([["id", "=", 5]], ["stage_id"]);
    expect(queryAllTexts(`${select} option`)).toEqual(["New", "Qualified", "Won"]);

    // Online, then offline: the ungrouped list saves a chosen stage on its record,
    // so a stage it does not offer is neither saved nor queued, and the lead keeps
    // its stage.
    for (const offline of [false, true]) {
        await setOffline(offline);
        for (const value of [String(proposalId), ...UNOFFERED_STAGE_VALUES]) {
            await selectCraftedStage(select, value);
            expect(calls.filter((call) => call.startsWith("crm.lead/"))).toEqual([]);
            expect(queued("crm.lead")).toEqual([]);
            expect(badge).toHaveCount(0);
            expect(serverStage()).toEqual([{ id: 5, stage_id: [QUALIFIED, "Qualified"] }]);
        }
    }

    // An offered stage still moves the lead: offline, its save is queued.
    await contains(select).select(String(NEW));
    const [save] = queued("crm.lead");
    expect(save.method).toBe("web_save");
    expect(save.args).toEqual([[5], { stage_id: NEW }]);
    expect(select).toHaveValue(String(NEW));
    expect(badge).toHaveText("Pending sync");
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
        contact_name: "",
        phone: "",
        email_from: "",
        expected_revenue: 80,
        stage_id: QUALIFIED,
    };
    expect(creates[0].args[1]).toEqual(newLeadValues);
    expect(creates[1].args[1]).toEqual(qualifiedLeadValues);
    // Creates (no id) in the pipeline list context, which holds the action's
    // `default_type`, with an empty specification, in queue order.
    const createKwargs = { context: { ...user.context, ...PIPELINE_CONTEXT }, specification: {} };
    const createCalls = [
        {
            model: "crm.lead",
            method: "web_save",
            args: [[], newLeadValues],
            kwargs: createKwargs,
        },
        {
            model: "crm.lead",
            method: "web_save",
            args: [[], qualifiedLeadValues],
            kwargs: createKwargs,
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
        kwargs: { context: user.context },
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
    // The user context only: no key of the lead action becomes an activity default.
    const createCall = {
        model: "mail.activity",
        method: "create",
        args: [[followUpValues]],
        kwargs: { context: user.context },
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
        kwargs: { context: user.context },
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
test("mobile activities: an open form keeps its type options when the cached types reread empty", async () => {
    mockDate("2026-10-02 10:00:00");
    // Once set, the cache reads return only the activity types of these ids.
    let readableTypeIds = null;
    patchWithCleanup(OfflinePlugin.prototype, {
        async searchMany2XRecords(model) {
            const records = await super.searchMany2XRecords(...arguments);
            if (model !== "mail.activity.type" || !readableTypeIds) {
                return records;
            }
            return (records || []).filter(({ id }) => readableTypeIds.includes(id));
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
    expect(received).toEqual([
        {
            model: "mail.activity",
            method: "create",
            args: [[followUpValues]],
            kwargs: { context: user.context },
        },
    ]);
    expect(".o_crm_mobile_activity_form").toHaveCount(0);
    expect(".o_crm_mobile_log_call").not.toBeEnabled();
    expect(".o_crm_mobile_schedule_followup").not.toBeEnabled();

    // Email and Call read at the next reconnection enable the openers again.
    readableTypeIds = [1, CALL_TYPE_ID];
    await setOffline(true);
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
    await setOffline(true);
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
    expect(".o_crm_mobile_lead_activities_sheet header .text-muted").toHaveText("Quote for Chairs");
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

    // The pager hotkey still reaches the form under the open sheet. The form's root
    // reload emits no model event: the sheet follows its lead and closes.
    await press(["alt", "n"]);
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

    // No request reached the server. The record searches read the cached partners
    // without attempting any request; the only attempt the lost network refused is
    // the framework's record save, which queues the call. No `name_search`, no
    // select-create dialog, no enrichment lookup.
    expect(serverCalls).toEqual([]);
    expect(attempts.filter((call) => call !== "crm.lead/web_save")).toEqual([]);
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
    // Stand-in for the lead form's `res_partner_many2one` widget, whose addon
    // (`partner_autocomplete`) is outside CRM's `depends` and not loaded here: a
    // many2one whose `otherSources` adds an enrichment suggestion for queries longer
    // than two characters.
    const enrichmentSelections = [];
    class EnrichmentPartnerMany2One extends Many2OneField {
        get m2oProps() {
            const enrichmentSource = {
                options: (request) =>
                    request.length > 2
                        ? [
                              {
                                  cssClass: "partner_autocomplete_dropdown_many2one",
                                  data: { name: "Azure Interior SA" },
                                  label: "Azure Interior SA",
                                  onSelect: () => enrichmentSelections.push("Azure Interior SA"),
                              },
                          ]
                        : [],
            };
            return { ...super.m2oProps, otherSources: [enrichmentSource] };
        }
    }
    registry
        .category("fields")
        .add("res_partner_many2one", buildM2OFieldDescription(EnrichmentPartnerMany2One));
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
    /** Every option renders selectable: an `<a role="option">`, not styled disabled. */
    const expectSelectable = () => {
        for (const item of [RECORD_ITEM, ...STALE_ITEMS]) {
            expect(`${item} a.dropdown-item[role=option]`).toHaveCount(1);
        }
        expect(".o-autocomplete--dropdown-item.o_disabled_offline").toHaveCount(0);
    };
    /**
     * The non-record options render unselectable (a `<span>`, no role) with the
     * framework's offline-disabled styling; the record option does not.
     */
    const expectStaleInert = () => {
        for (const item of STALE_ITEMS) {
            expect(`${item} span.dropdown-item:not([role])`).toHaveCount(1);
            expect(`${item} a`).toHaveCount(0);
            expect(`${item}.o_disabled_offline`).toHaveCount(1);
        }
        expect(`${RECORD_ITEM} a.dropdown-item[role=option]`).toHaveCount(1);
        expect(`${RECORD_ITEM}.o_disabled_offline`).toHaveCount(0);
    };
    let calls = [];
    /** Opens the dropdown online with "Azu": every option is selectable. */
    const openOnline = async () => {
        await setOffline(false);
        await searchPartner("Azu");
        expect(queryAllTexts(".o-autocomplete--dropdown-item")).toEqual([
            "Azure Interior",
            'Create "Azu"',
            "Create and edit...",
            "Search more...",
            "Azure Interior SA",
        ]);
        expectSelectable();
    };
    /** Disconnects with the dropdown open: its options stay, the non-record ones inert. */
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
    expect(".o-autocomplete--dropdown-item").toHaveCount(5);
    expectSelectable();
    await disconnect();

    // Clicked: not selected, the dropdown stays open.
    for (const item of STALE_ITEMS) {
        await contains(item).click();
        await animationFrame();
        expectNothingHappened();
        expectStaleInert();
    }

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

    // The record option stays usable, and on the phone the field searches inline.
    await contains(RECORD_ITEM).click();
    expect(PARTNER_INPUT).toHaveValue("Azure Interior");
    expect(".o-autocomplete--dropdown-menu").toHaveCount(0);
    // Reconnected, Search more opens its dialog.
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

    // C: the card then chooses "Won" through the framework's group move, which queues
    // it at the held time, the time of B and before A: the choice is queued last too.
    await contains(`${card("Office Design")} .o_crm_mobile_lead_stage`).select(String(WON));
    expect(stageWrites().at(-1)).toEqual([WON, 2]);
    expect(writeTimes()).toEqual([0, 0, 1, 2]);
    expect(cardNames()).toEqual(["Quote for Chairs", "Desk Upgrade"]);
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(textOf(".o_crm_mobile_pipeline_stage_name")).toBe("Won");
    expect(cardNames()).toEqual(["Office Design"]);
    expect(`${card("Office Design")} .o_crm_mobile_lead_stage`).toHaveValue(String(WON));

    // D, a minute later: the card's Record queues "Qualified" under its first save's
    // time again, before A and C: the choice is queued last, at the current time.
    clock += 60_000;
    await contains(`${card("Office Design")} .o_crm_mobile_lead_stage`).select(String(QUALIFIED));
    expect(stageWrites().at(-1)).toEqual([QUALIFIED, 60_000]);
    expect(writeTimes()).toEqual([0, 0, 1, 2, 60_000]);
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
    expect(".o_offline_systray_content .o-dropdown-item").toHaveCount(5);
    const systrayChanges = queryAll(
        ".o_offline_systray_content .o-dropdown-item [data-tooltip-info]"
    ).map((el) => JSON.parse(el.dataset.tooltipInfo).changes);
    expect(systrayChanges.slice(2)).toEqual([
        [["stage_id", "Qualified", "New"]],
        [["stage_id", "New", "Won"]],
        [["stage_id", "Won", "Qualified"]],
    ]);
    await press("Escape");
    await animationFrame();
    expect(".o_offline_systray_content").toHaveCount(0);

    // Each a lead write with an empty specification, in the context of its Record: B
    // in the form's (the pipeline context), the card's writes in the card's, which
    // adds the `default_stage_id` the framework gives the stage group the lead was
    // loaded in. B and the card's own write share a timestamp: either may come first.
    const formContext = { ...user.context, ...PIPELINE_CONTEXT };
    const cardContext = { ...formContext, default_stage_id: NEW };
    const stageWrite = (stageId, context) => ({
        model: "crm.lead",
        method: "web_save",
        args: [[1], { stage_id: stageId }],
        kwargs: { context, specification: {} },
    });
    const firstWrites = [stageWrite(QUALIFIED, formContext), stageWrite(QUALIFIED, cardContext)];
    const lastWrites = [
        stageWrite(NEW, cardContext),
        stageWrite(WON, cardContext),
        stageWrite(QUALIFIED, cardContext),
    ];
    const queuedWrites = queued("crm.lead").map(ormCall);
    expect(queuedWrites.slice(0, 2)).toEqual(firstWrites, { ignoreOrder: true });
    expect(queuedWrites.slice(2)).toEqual(lastWrites);

    // Replayed in timestamp order (B and the card's own write, then A, C and D), the
    // last choice reaches the server last.
    const replayStart = calls.length;
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(received.map(({ args }) => args[1].stage_id)).toEqual([
        QUALIFIED,
        QUALIFIED,
        NEW,
        WON,
        QUALIFIED,
    ]);
    expect(received.slice(0, 2)).toEqual(firstWrites, { ignoreOrder: true });
    expect(received.slice(2)).toEqual(lastWrites);
    expect(calls.slice(replayStart).filter((call) => WRITE_CALL.test(call))).toEqual(
        Array(5).fill("crm.lead/web_save")
    );
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(QUALIFIED);
    expect(cardNames()).toEqual(["Office Design", "Conference Room", "Lamps", "Storage Racks"]);
    expect(".modal").toHaveCount(0);
    // The framework's own cached pipeline load offline.
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
