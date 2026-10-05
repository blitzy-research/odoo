/**
 * Offline behaviour of the CRM entry points classified in
 * `crm/static/src/mobile/offline_inventory.md`, through the real views, web client and
 * framework offline plugin:
 *
 * - SKIP: advisory reads (rainbowman lookup, recurring-revenue probe) are neither
 *   issued nor queued offline;
 * - QUEUE: lead, stage and team writes are queued by the framework (by the lead form
 *   for "Won"), shown at once and replayed on reconnection;
 * - DISABLE: every other control is inert offline by click, keyboard, hotkey and
 *   direct call, and works again online.
 *
 * Queue assertions read genuine framework queue entries. Replay follows their time
 * stamps (last write wins), and a replay the mock server rejects is parked in the
 * offline systray.
 *
 * Offline cache-fallback and startup errors are declared explicitly. Tests injecting
 * server failures also declare those failures; each assertion checks the exact
 * expected error and unexpected CRM failures remain visible.
 *
 * Untagged tests run under both presets; tests needing desktop markup are tagged
 * "desktop".
 */

import { Component, effect, onWillDestroy, untrack, xml } from "@odoo/owl";
import {
    advanceTime,
    after,
    beforeEach,
    expect,
    mockDate,
    mockSendBeacon,
    mockUserAgent,
    runAllTimers,
    test,
} from "@odoo/hoot";
import {
    animationFrame,
    click,
    getFocusableElements,
    hover,
    microTick,
    press,
    queryAll,
    queryAllTexts,
    queryFirst,
    unload,
    waitFor,
    waitUntil,
} from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineMenus,
    defineModels,
    fields,
    getFacetTexts,
    getService,
    isSmall,
    makeMockServer,
    makeTestApp,
    makeServerError,
    mockOffline,
    MockServer,
    models,
    mountView,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    registerInlineViewArchs,
    serverState,
    toggleActionMenu,
    toggleMenuItem,
} from "@web/../tests/web_test_helpers";
import { clickDate } from "@web/../tests/views/calendar/calendar_test_helpers";
import { defineCrmModels } from "@crm/../tests/crm_test_helpers";
import { dragenterFiles, dropFiles, start, startServer } from "@mail/../tests/mail_test_helpers";
import { MailComposerFormController } from "@mail/chatter/web/mail_composer_form";
import { Chatter } from "@mail/chatter/web_portal_project/chatter";
import { Composer } from "@mail/core/common/composer";
import { Thread } from "@mail/core/common/thread";
import { ActivityButton } from "@mail/core/web/activity_button";
import { Follower } from "@mail/core/web/follower";
import { FollowerList } from "@mail/core/web/follower_list";
import { FollowerSubtypeDialog } from "@mail/core/web/follower_subtype_dialog";
import { Avatar } from "@mail/views/web/fields/avatar/avatar";
import {
    CRM_MOBILE_ACTIVITY_LIMIT,
    CRM_OFFLINE_CREATE_KEY,
    CRM_OFFLINE_DISABLED_ACTIONS,
    CRM_OFFLINE_UID_KEY,
    CRM_OFFLINE_DISABLED_MENUS,
    useCrmOffline,
} from "@crm/mobile/crm_offline_hooks";
import {
    CrmInstallConfirmationDialog,
    LeadGenerationDropdown,
} from "@crm/components/lead_generation_dropdown/lead_generation_dropdown";
import { CrmFormController } from "@crm/views/crm_form/crm_form";
import { CrmPlsTooltipButton } from "@crm/views/crm_form/crm_pls_tooltip_button";
import { CrmShareTargetItem } from "@crm/webclient/share_target/crm_share_target_item";
import { AutoComplete } from "@web/core/autocomplete/autocomplete";
import { browser } from "@web/core/browser/browser";
import { router } from "@web/core/browser/router";
import { ConnectionLostError, RPCError } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
import { registerTemplate } from "@web/core/templates";
import { user } from "@web/core/user";
import { useService } from "@web/core/utils/hooks";
import { ActionMenus } from "@web/search/action_menus/action_menus";
import { session } from "@web/session";
import { computeM2OProps, KanbanMany2One, Many2One } from "@web/views/fields/many2one/many2one";
import { buildM2OFieldDescription, Many2OneField } from "@web/views/fields/many2one/many2one_field";
import { Many2ManyTagsField } from "@web/views/fields/many2many_tags/many2many_tags_field";
import { PhoneField } from "@web/views/fields/phone/phone_field";
import { Many2XAutocomplete } from "@web/views/fields/relational_utils";
import { FormController } from "@web/views/form/form_controller";
import { KanbanRecord } from "@web/views/kanban/kanban_record";
import { View } from "@web/views/view";
import { AnimatedNumber } from "@web/views/view_components/animated_number";
import { shareTargetService } from "@web/webclient/share_target/share_target_service";
import { WebClient } from "@web/webclient/webclient";

// -----------------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------------

const STAGE_NEW = 1;
const STAGE_QUALIFIED = 2;
const STAGE_WON = 3;
/** Mock "Call" activity type (mail `mail.activity.type` records). */
const CALL_ACTIVITY_TYPE_ID = 2;

class CrmStage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();
    is_won = fields.Boolean({ string: "Is won" });
    fold = fields.Boolean({ string: "Folded" });
    sequence = fields.Integer();

    _records = [
        { id: STAGE_NEW, name: "New", sequence: 1 },
        { id: STAGE_QUALIFIED, name: "Qualified", sequence: 2 },
        { id: STAGE_WON, name: "Won", sequence: 3, is_won: true },
    ];

    _views = {
        form: /* xml */ `
            <form>
                <sheet>
                    <field name="name"/>
                    <field name="is_won"/>
                    <field name="fold"/>
                </sheet>
            </form>`,
        list: /* xml */ `<list><field name="name"/></list>`,
        search: /* xml */ `<search/>`,
    };
}

class CrmTeam extends models.Model {
    _name = "crm.team";

    name = fields.Char();
    color = fields.Integer();
    user_id = fields.Many2one({ string: "Team Leader", relation: "res.users" });
    member_ids = fields.Many2many({ string: "Members", relation: "res.users" });
    company_id = fields.Many2one({ relation: "res.company" });
    use_leads = fields.Boolean();
    use_opportunities = fields.Boolean();
    lead_unassigned_count = fields.Integer();
    lead_properties_definition = fields.PropertiesDefinition();
    assignment_enabled = fields.Boolean();
    is_membership_multi = fields.Boolean();
    member_warning = fields.Char();
    opportunity_count = fields.Integer();

    _records = [
        {
            id: 1,
            name: "Europe",
            color: 1,
            use_leads: true,
            use_opportunities: true,
            lead_unassigned_count: 2,
            lead_properties_definition: [{ name: "budget_owner", string: "Budget owner", type: "char" }],
            assignment_enabled: true,
            member_warning: "Mitchell Admin belongs to Europe and America.",
            opportunity_count: 2,
        },
        {
            id: 2,
            name: "America",
            color: 2,
            use_opportunities: true,
            lead_unassigned_count: 0,
            lead_properties_definition: [],
        },
    ];

    _views = {
        kanban: TEAM_DASHBOARD_ARCH,
        // sales_team's form (multi-membership alert) with the CRM inherit's
        // "Assign Leads" header button and "Opportunities" stat button.
        form: /* xml */ `
            <form js_class="crm_team_form">
                <field name="use_leads" invisible="1"/>
                <field name="use_opportunities" invisible="1"/>
                <field name="assignment_enabled" invisible="1"/>
                <header invisible="not use_leads and not use_opportunities or not assignment_enabled">
                    <button name="action_assign_leads" type="object" string="Assign Leads"
                        class="oe_highlight"
                        confirm="This will assign leads to all members. Do you want to proceed?"
                        confirm-label="Assign Leads"/>
                </header>
                <div class="alert alert-info text-center d-flex flex-wrap justify-content-center gap-1" role="alert"
                    invisible="is_membership_multi or not member_warning">
                    <field name="member_warning" class="w-auto"/>
                    Working in multiple teams?
                    <button name="crm_team_activate_multi_membership" type="button" class="btn btn-link p-0 lh-1">
                        Activate "Multi-team"
                    </button>
                </div>
                <sheet>
                    <div class="oe_button_box" name="button_box">
                        <button name="action_open_opportunities" type="object" class="oe_stat_button" icon="fa-star">
                            <div class="o_field_widget o_stat_info">
                                <span class="o_stat_value"><field nolabel="1" name="opportunity_count"/></span>
                                <span class="o_stat_text">Opportunities</span>
                            </div>
                        </button>
                    </div>
                    <field name="name"/>
                    <field name="user_id"/>
                    <field name="is_membership_multi" invisible="1"/>
                </sheet>
            </form>`,
        search: /* xml */ `<search/>`,
    };

    action_assign_leads(ids) {
        return stepServerCall("action_assign_leads", ids);
    }

    action_open_opportunities(ids) {
        return stepServerCall("action_open_opportunities", ids);
    }

    action_primary_channel_button() {
        expect.step("crm.team.action_primary_channel_button");
        return false;
    }

    action_open_unassigned_opportunities() {
        expect.step("crm.team.action_open_unassigned_opportunities");
        return false;
    }
}

class CrmTag extends models.Model {
    _name = "crm.tag";

    name = fields.Char();
    color = fields.Integer();

    _records = [
        { id: 1, name: "Hot", color: 1 },
        { id: 2, name: "Cold", color: 4 },
    ];
}

/**
 * Lead fixture. Merged by the mock server with the shared `crm.lead` server model of
 * `defineCrmModels()` (real field definitions, mail thread), so only the fields and
 * methods these tests rely on are declared here.
 */
class CrmLead extends models.Model {
    _name = "crm.lead";

    // Required, as on the server.
    name = fields.Char({ required: true });
    type = fields.Selection({
        selection: [
            ["lead", "Lead"],
            ["opportunity", "Opportunity"],
        ],
        default: "opportunity",
    });
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });
    user_id = fields.Many2one({ string: "Salesperson", relation: "res.users" });
    partner_id = fields.Many2one({ string: "Customer", relation: "res.partner" });
    contact_name = fields.Char();
    email_from = fields.Char({ string: "Email" });
    phone = fields.Char();
    // Readonly computed fields on the server: never written by a save.
    partner_email_update = fields.Boolean({ readonly: true });
    partner_phone_update = fields.Boolean({ readonly: true });
    phone_sanitized = fields.Char({ string: "Sanitized Number", readonly: true });
    phone_formatted = fields.Char({ string: "Formatted Number", readonly: true });
    is_blacklisted = fields.Boolean();
    phone_blacklisted = fields.Boolean();
    expected_revenue = fields.Float({ string: "Expected Revenue", aggregator: "sum" });
    recurring_revenue_monthly = fields.Float({ string: "Expected MRR", aggregator: "sum" });
    planned_revenue = fields.Float({ string: "Revenue" });
    probability = fields.Float();
    automated_probability = fields.Float();
    is_automated_probability = fields.Boolean();
    won_status = fields.Selection({
        selection: [
            ["pending", "Pending"],
            ["won", "Won"],
            ["lost", "Lost"],
        ],
        default: "pending",
    });
    active = fields.Boolean({ default: true });
    color = fields.Integer();
    tag_ids = fields.Many2many({ string: "Tags", relation: "crm.tag" });
    date_closed = fields.Datetime({ string: "Closed Date" });
    duplicate_lead_count = fields.Integer();
    meeting_display_label = fields.Char();
    activity_state = fields.Selection({
        selection: [
            ["overdue", "Overdue"],
            ["today", "Today"],
            ["planned", "Planned"],
        ],
    });

    _records = [
        {
            id: 1,
            name: "Lead 1",
            stage_id: STAGE_NEW,
            team_id: 1,
            user_id: serverState.userId,
            planned_revenue: 5,
            expected_revenue: 5,
            probability: 10,
            email_from: "one@example.com",
            phone: "+32 470 00 00 01",
            tag_ids: [1],
        },
        {
            id: 2,
            name: "Lead 2",
            stage_id: STAGE_NEW,
            team_id: 1,
            user_id: serverState.userId,
            planned_revenue: 7,
            expected_revenue: 7,
            probability: 20,
        },
        {
            id: 3,
            name: "Lead 3",
            stage_id: STAGE_NEW,
            team_id: 2,
            user_id: serverState.userId,
            planned_revenue: 3,
            expected_revenue: 3,
            probability: 30,
        },
        {
            id: 4,
            name: "Lead 4",
            stage_id: STAGE_QUALIFIED,
            team_id: 2,
            user_id: serverState.userId,
            planned_revenue: 4,
            expected_revenue: 4,
            probability: 40,
        },
        {
            id: 5,
            name: "Lead 5",
            stage_id: STAGE_WON,
            team_id: 2,
            user_id: false,
            planned_revenue: 9,
            expected_revenue: 9,
            probability: 100,
            won_status: "won",
        },
    ];

    _views = {
        form: LEAD_FORM_ARCH,
        [`form,${LEAD_FULL_FORM_VIEW_ID}`]: LEAD_FORM_FULL_ARCH,
        [`list,${LEAD_LIST_VIEW_ID}`]: LEAD_LIST_ARCH,
        // Forecast (`crm_lead_view_kanban_forecast`, `crm_lead_view_tree_forecast`).
        [`kanban,${FORECAST_KANBAN_VIEW_ID}`]: /* xml */ `
            <kanban js_class="forecast_kanban" default_group_by="date_deadline:month">
                <field name="date_deadline"/>
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                    </t>
                </templates>
            </kanban>`,
        [`list,${FORECAST_LIST_VIEW_ID}`]: /* xml */ `
            <list js_class="forecast_list">
                <field name="name"/>
                <field name="date_deadline"/>
            </list>`,
        // Report and analysis views (`crm_lead_view_graph`, `crm_lead_view_pivot`,
        // `crm_case_calendar_view_leads`, `crm_lead_view_activity`).
        graph: /* xml */ `
            <graph string="Opportunities">
                <field name="stage_id" type="col"/>
                <field name="user_id" type="row"/>
            </graph>`,
        pivot: /* xml */ `
            <pivot string="Pipeline Analysis">
                <field name="stage_id" type="col"/>
                <field name="expected_revenue" type="measure"/>
            </pivot>`,
        // Graph of the lead report whose action alone is loaded online.
        [`graph,${COLD_REPORT_GRAPH_VIEW_ID}`]: /* xml */ `
            <graph string="Revenue by team">
                <field name="team_id" type="row"/>
                <field name="expected_revenue" type="measure"/>
            </graph>`,
        calendar: /* xml */ `
            <calendar string="Leads" date_start="date_deadline" mode="month">
                <field name="name"/>
            </calendar>`,
        activity: /* xml */ `
            <activity string="Leads">
                <templates>
                    <div t-name="activity-box">
                        <field name="name"/>
                    </div>
                </templates>
            </activity>`,
        kanban: pipelineArch(),
        // Opportunities list activity controls: `list_activity` and the reschedule dropdown.
        [`list,${ACTIVITY_LIST_VIEW_ID}`]: /* xml */ `
            <list>
                <field name="name"/>
                <field name="activity_ids" widget="list_activity"/>
                <field name="my_activity_date_deadline" column_invisible="True"/>
                <widget name="mail_activity_mixin_list_reschedule_dropdown"/>
            </list>`,
        // Pipeline cards with their `kanban_activity` button (wide layout).
        [`kanban,${ACTIVITY_KANBAN_VIEW_ID}`]: pipelineArch({ activities: true }),
        // Pipeline loading two leads per column ("New" is then partially loaded).
        [`kanban,${LIMITED_KANBAN_VIEW_ID}`]: pipelineArch({ limit: 2 }),
        // The `crm_kanban` view with the recurring-revenue progress bar: its column
        // progress (`CrmColumnProgress`) renders under both presets, whereas the
        // pipeline's small-screen layout has no column progress.
        [`kanban,${RECURRING_KANBAN_VIEW_ID}`]: /* xml */ `
            <kanban js_class="crm_kanban" default_group_by="stage_id" archivable="false">
                <field name="activity_state"/>
                <progressbar field="activity_state" colors='{"planned": "success", "today": "warning", "overdue": "danger"}'
                    sum_field="expected_revenue" recurring_revenue_sum_field="recurring_revenue_monthly"/>
                <templates>
                    <t t-name="card">
                        <field name="name" class="fw-bold"/>
                        <field name="recurring_revenue_monthly"/>
                    </t>
                </templates>
            </kanban>`,
        list: /* xml */ `
            <list>
                <field name="name"/>
                <field name="stage_id"/>
            </list>`,
        search: /* xml */ `
            <search>
                <field name="name"/>
                <field name="team_id"/>
                <filter name="my_team" string="My Team" domain="[('team_id', '=', 1)]"/>
            </search>`,
    };

    /** The server marks the lead won: won stage, won status and 100%. */
    action_set_won(ids) {
        this.write(ids, { stage_id: STAGE_WON, won_status: "won", probability: 100 });
        return true;
    }

    action_set_won_rainbowman(ids) {
        expect.step(`action_set_won_rainbowman ${JSON.stringify(ids)}`);
        this.write(ids, { stage_id: STAGE_WON, won_status: "won", probability: 100 });
        return true;
    }

    action_archive(ids) {
        this.write(ids, { active: false });
        return true;
    }

    action_unarchive(ids) {
        this.write(ids, { active: true });
        return true;
    }

    // DISABLE buttons of the lead form, pipeline and lists: each call that reaches the
    // server is stepped, so a missing (or an unexpected) call is provable.
    action_convert_to_opportunity(ids) {
        return stepServerCall("action_convert_to_opportunity", ids);
    }

    action_restore(ids) {
        return stepServerCall("action_restore", ids);
    }

    action_schedule_meeting(ids) {
        return stepServerCall("action_schedule_meeting", ids);
    }

    action_show_potential_duplicates(ids) {
        return stepServerCall("action_show_potential_duplicates", ids);
    }

    action_set_automated_probability(ids) {
        return stepServerCall("action_set_automated_probability", ids);
    }

    mail_action_blacklist_remove(ids) {
        return stepServerCall("mail_action_blacklist_remove", ids);
    }

    phone_action_blacklist_remove(ids) {
        return stepServerCall("phone_action_blacklist_remove", ids);
    }

    action_reschedule_my_next_today(ids) {
        return stepServerCall("action_reschedule_my_next_today", ids);
    }

    /** Predictive lead scoring tooltip data (`crm.lead.prepare_pls_tooltip_data`). */
    prepare_pls_tooltip_data(resId) {
        expect.step(`prepare_pls_tooltip_data ${resId}`);
        return {
            probability: 42,
            team_name: "Europe",
            top_3_data: [{ field: "country_id", value: "Belgium", probability: 0.6 }],
            low_3_data: [{ field: "source_id", value: "Newsletter", probability: 0.2 }],
        };
    }
}

/**
 * Steps a server method call (`"<method> <ids>"`) and returns `false`, so the client
 * closes the dialog or reloads the form as it does after a real button call.
 *
 * @param {string} method
 * @param {any} ids
 */
function stepServerCall(method, ids) {
    expect.step(`${method} ${JSON.stringify(ids)}`);
    return false;
}

/** Lost reason (`crm.lost.reason`): its form opens the leads lost for that reason. */
class CrmLostReason extends models.Model {
    _name = "crm.lost.reason";

    name = fields.Char();
    leads_count = fields.Integer({ string: "Leads" });

    _records = [{ id: 1, name: "Too expensive", leads_count: 2 }];

    _views = {
        form: /* xml */ `
            <form>
                <sheet>
                    <div class="oe_button_box" name="button_box">
                        <button name="action_lost_leads" type="object" class="oe_stat_button" icon="fa-star">
                            <field name="leads_count" widget="statinfo"/>
                        </button>
                    </div>
                    <field name="name"/>
                </sheet>
            </form>`,
        list: /* xml */ `<list><field name="name"/></list>`,
        search: /* xml */ `<search/>`,
    };

    action_lost_leads(ids) {
        return stepServerCall("action_lost_leads", ids);
    }
}

/** "Mark Lost" wizard (`crm.lead.lost`, `crm_lead_lost_view_form`). */
class CrmLeadLost extends models.Model {
    _name = "crm.lead.lost";

    lead_ids = fields.Many2many({ string: "Leads", relation: "crm.lead" });
    lost_feedback = fields.Char({ string: "Closing Note" });

    _views = {
        form: /* xml */ `
            <form string="Lost Lead">
                <field name="lead_ids" invisible="1"/>
                <group>
                    <field name="lost_feedback" placeholder="What went wrong?"/>
                </group>
                <footer>
                    <button name="action_lost_reason_apply" string="Mark as Lost" type="object" class="btn-primary" data-hotkey="q"/>
                    <button class="btn-secondary" special="cancel" data-hotkey="x"/>
                </footer>
            </form>`,
    };

    action_lost_reason_apply(ids) {
        return stepServerCall("action_lost_reason_apply", ids);
    }
}

/** Mass conversion wizard (`crm.lead2opportunity.partner.mass`). */
class CrmLead2OpportunityPartnerMass extends models.Model {
    _name = "crm.lead2opportunity.partner.mass";

    name = fields.Selection({
        string: "Conversion Action",
        selection: [
            ["convert", "Convert to opportunity"],
            ["merge", "Merge with existing opportunities"],
        ],
        default: "convert",
    });
    deduplicate = fields.Boolean({ string: "Apply deduplication", default: true });
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });

    _views = {
        form: /* xml */ `
            <form string="Convert to Opportunity">
                <group>
                    <field name="name" widget="radio"/>
                    <field name="deduplicate"/>
                    <field name="team_id"/>
                </group>
                <footer>
                    <button string="Convert" name="action_apply" type="object" class="btn-primary" data-hotkey="q"/>
                    <button class="btn-secondary" special="cancel" data-hotkey="x"/>
                </footer>
            </form>`,
    };

    action_apply(ids) {
        return stepServerCall("action_apply", ids);
    }
}

/** Merge wizard (`crm.merge.opportunity`). */
class CrmMergeOpportunity extends models.Model {
    _name = "crm.merge.opportunity";

    user_id = fields.Many2one({ string: "Salesperson", relation: "res.users" });
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });
    opportunity_ids = fields.Many2many({ string: "Leads/Opportunities", relation: "crm.lead" });

    _views = {
        form: /* xml */ `
            <form string="Merge Leads/Opportunities">
                <group>
                    <field name="user_id"/>
                    <field name="team_id"/>
                </group>
                <field name="opportunity_ids" nolabel="1">
                    <list>
                        <field name="name" string="Title"/>
                    </list>
                </field>
                <footer>
                    <button name="action_merge" type="object" string="Merge" class="btn-primary" data-hotkey="q"/>
                    <button class="btn-secondary" special="cancel" data-hotkey="x"/>
                </footer>
            </form>`,
    };

    action_merge(ids) {
        return stepServerCall("action_merge", ids);
    }
}

/** Probability update wizard (`crm.lead.pls.update`). */
class CrmLeadPlsUpdate extends models.Model {
    _name = "crm.lead.pls.update";

    pls_start_date = fields.Char({ string: "Consider leads created as of the" });

    _views = {
        form: /* xml */ `
            <form>
                <group>
                    <field name="pls_start_date"/>
                </group>
                <footer>
                    <button name="action_update_crm_lead_probabilities" type="object" string="Confirm" class="btn-primary" data-hotkey="q"/>
                    <button special="cancel" data-hotkey="x"/>
                </footer>
            </form>`,
    };

    action_update_crm_lead_probabilities(ids) {
        return stepServerCall("action_update_crm_lead_probabilities", ids);
    }
}

/** Followers wizard of "Add/Remove Followers" (`mail.followers.edit`). */
class MailFollowersEdit extends models.Model {
    _name = "mail.followers.edit";

    res_model = fields.Char();

    _views = {
        form: /* xml */ `
            <form>
                <field name="res_model"/>
                <footer>
                    <button special="cancel" string="Discard"/>
                </footer>
            </form>`,
    };
}

/** Recurring plans (`crm.recurring.plan`), opened from the CRM settings. */
class CrmRecurringPlan extends models.Model {
    _name = "crm.recurring.plan";

    name = fields.Char();
    number_of_months = fields.Integer();

    _records = [{ id: 1, name: "Monthly", number_of_months: 1 }];

    _views = {
        list: /* xml */ `<list><field name="name"/><field name="number_of_months"/></list>`,
        search: /* xml */ `<search/>`,
    };
}

/** Activity analysis (`crm.activity.report`): every view is a report view. */
class CrmActivityReport extends models.Model {
    _name = "crm.activity.report";

    subject = fields.Char();
    lead_id = fields.Many2one({ string: "Opportunity", relation: "crm.lead" });
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });

    _records = [{ id: 1, subject: "Call Europe", lead_id: 1, team_id: 1 }];

    _views = {
        graph: /* xml */ `<graph><field name="team_id"/></graph>`,
        pivot: /* xml */ `<pivot><field name="team_id" type="row"/></pivot>`,
        list: /* xml */ `
            <list action="action_open_lead" type="object">
                <field name="subject"/>
                <field name="lead_id"/>
            </list>`,
        search: /* xml */ `<search/>`,
    };

    action_open_lead(ids) {
        return stepServerCall("action_open_lead", ids);
    }
}

/** Modules of the lead generation dropdown (`ir.module.module`). */
class IrModuleModule extends models.Model {
    _name = "ir.module.module";

    name = fields.Char();
    shortdesc = fields.Char();

    _records = [
        { id: 1, name: "crm_iap_mine", shortdesc: "Lead Generation" },
        { id: 2, name: "website", shortdesc: "Website" },
        { id: 3, name: "mass_mailing", shortdesc: "Email Marketing" },
        { id: 4, name: "survey", shortdesc: "Surveys" },
    ];
}

/** Marketing campaigns (`utm.campaign`) with the CRM lead counters. */
class UtmCampaign extends models.Model {
    _name = "utm.campaign";

    name = fields.Char();
    use_leads = fields.Boolean();
    crm_lead_count = fields.Integer({ string: "Leads/Opportunities count" });

    _records = [{ id: 1, name: "Spring Fair", use_leads: false, crm_lead_count: 3 }];

    _views = {
        // `utm_campaign_view_kanban` with the CRM inherit (lead counter link).
        kanban: /* xml */ `
            <kanban>
                <field name="use_leads"/>
                <templates>
                    <t t-name="card">
                        <field name="name" class="fw-bold"/>
                        <footer>
                            <div class="d-flex">
                                <t t-if="record.use_leads.raw_value">
                                    <t t-set="crm_lead_count_label">Leads</t>
                                </t>
                                <t t-else="">
                                    <t t-set="crm_lead_count_label">Opportunities</t>
                                </t>
                                <a t-if="record.crm_lead_count" href="#" t-att-title="crm_lead_count_label" role="button"
                                    type="object" name="action_redirect_to_leads_opportunities"
                                    class="btn-outline-primary rounded-pill me-1 order-3">
                                    <span class="badge">
                                        <i class="fa fa-fw fa-star" t-att-aria-label="crm_lead_count_label" role="img"/>
                                        <field name="crm_lead_count"/>
                                    </span>
                                </a>
                            </div>
                        </footer>
                    </t>
                </templates>
            </kanban>`,
        // `utm_campaign_view_form` with the CRM inherit (lead counter stat button).
        form: /* xml */ `
            <form>
                <sheet>
                    <div class="oe_button_box" name="button_box">
                        <button name="action_redirect_to_leads_opportunities" type="object"
                            class="oe_stat_button order-3" icon="fa-star">
                            <div class="o_field_widget o_stat_info">
                                <field name="use_leads" invisible="1"/>
                                <span class="o_stat_value"><field nolabel="1" name="crm_lead_count"/></span>
                                <span class="o_stat_text" invisible="not use_leads">Leads</span>
                                <span class="o_stat_text" invisible="use_leads">Opportunities</span>
                            </div>
                        </button>
                    </div>
                    <field name="name"/>
                </sheet>
            </form>`,
        search: /* xml */ `<search/>`,
    };

    action_redirect_to_leads_opportunities(ids) {
        return stepServerCall("action_redirect_to_leads_opportunities", ids);
    }
}

/**
 * CRM settings (`res_config_settings_view_form`, opened with `context.module` "crm"),
 * restricted to the three CRM buttons: recurring plans, probability update and lead
 * assignment. A plain form: the buttons and their guards do not depend on the
 * settings renderer.
 */
class ResConfigSettings extends models.Model {
    _name = "res.config.settings";

    group_use_recurring_revenues = fields.Boolean({ string: "Recurring Revenues" });
    crm_use_auto_assignment = fields.Boolean({ string: "Rule-Based Assignment" });

    _views = {
        form: /* xml */ `
            <form string="Settings">
                <group>
                    <field name="group_use_recurring_revenues"/>
                    <button type="action" name="crm.crm_recurring_plan_action" string="Recurring Plans" class="btn-link"/>
                    <button name="${24}" type="action" string="Update Probabilities" class="btn-link"/>
                    <field name="crm_use_auto_assignment"/>
                    <button name="action_crm_assign_leads" type="object" string="Assign now" class="btn-link"/>
                </group>
            </form>`,
    };

    action_crm_assign_leads(ids) {
        return stepServerCall("action_crm_assign_leads", ids);
    }
}

/**
 * Partner form (`base.view_partner_form` with the CRM inherit `crm.view_partners_form_crm1`):
 * the opportunities stat button. Mounted with this arch: `res.partner` is the shared
 * mail mock, left untouched.
 */
const PARTNER_FORM_ARCH = /* xml */ `
    <form>
        <sheet>
            <div class="oe_button_box" name="button_box">
                <button class="oe_stat_button o_res_partner_tip_opp" type="object"
                    name="action_view_opportunity" icon="fa-star"
                    context="{'default_partner_id': id, 'default_type': 'opportunity'}">
                    <field string="Opportunities" name="opportunity_count" widget="statinfo"/>
                </button>
            </div>
            <field name="name"/>
        </sheet>
    </form>`;

// The lead properties field checks the write access on its definition record (the
// lead's team); the test user manages the teams.
onRpc("crm.team", "has_access", () => true);

// The lead actions the lead form queues offline (Won, Archive, Unarchive) are stepped
// with their payload whenever they reach the mock server, online or replayed.
for (const method of ["action_set_won", "action_archive", "action_unarchive"]) {
    stepCalls("crm.lead", method);
}

defineCrmModels();
defineModels([
    CrmStage,
    CrmTeam,
    CrmTag,
    CrmLead,
    CrmLostReason,
    CrmLeadLost,
    CrmLead2OpportunityPartnerMass,
    CrmMergeOpportunity,
    CrmLeadPlsUpdate,
    MailFollowersEdit,
    CrmRecurringPlan,
    CrmActivityReport,
    IrModuleModule,
    UtmCampaign,
    ResConfigSettings,
]);

// -----------------------------------------------------------------------------
// Arches
// -----------------------------------------------------------------------------

/** Header and stage statusbar of the lead form (`crm_lead_view_form`). */
const LEAD_FORM_HEADER = /* xml */ `
    <header>
        <button name="action_set_won_rainbowman" string="Won" type="object" class="oe_highlight"
            data-hotkey="w" title="Mark as won" data-available-offline="1"
            invisible="won_status == 'won' or type == 'lead' or not active"/>
        <field name="stage_id" widget="rotting_statusbar_duration"
            options="{'clickable': '1', 'fold_field': 'fold', 'crm_call_activity_type_id': ${CALL_ACTIVITY_TYPE_ID}}"
            invisible="type == 'lead'" readonly="won_status == 'lost' or not active"/>
    </header>`;

/** Lead form arch (`js_class="crm_form"`), restricted to the fields under test. */
const LEAD_FORM_ARCH = /* xml */ `
    <form js_class="crm_form">
        ${LEAD_FORM_HEADER}
        <sheet>
            <field name="won_status" invisible="1"/>
            <field name="active" invisible="1"/>
            <field name="type" invisible="1"/>
            <widget name="web_ribbon" title="Archived" bg_color="text-bg-danger" invisible="active or won_status in ['lost', 'won']"/>
            <widget name="web_ribbon" title="Won" invisible="won_status != 'won'"/>
            <field name="name"/>
            <field name="expected_revenue"/>
            <field name="probability" readonly="won_status != 'pending'"/>
            <field name="partner_email_update" invisible="1"/>
            <field name="partner_phone_update" invisible="1"/>
            <field name="email_from"/>
            <field name="phone"/>
            <field name="team_id"/>
            <field name="user_id"/>
        </sheet>
    </form>`;

/** View id of `LEAD_FORM_FULL_ARCH` in the `crm.lead` views. */
const LEAD_FULL_FORM_VIEW_ID = 100;
/** Ids of the actions the Sales Teams dashboard card menu links name (`%(...)d`). */
const TEAM_PIPELINE_ACTION_ID = 11;
const TEAM_REPORT_ACTION_ID = 12;
const TEAM_LEADS_ACTION_ID = 13;
const NEW_LEAD_ACTION_ID = 14;
const NEW_OPPORTUNITY_ACTION_ID = 15;
const ACTIVITY_REPORT_TEAM_ACTION_ID = 34;
const LEAD_SALESTEAM_REPORT_ACTION_ID = 35;
/** View id of `LEAD_LIST_ARCH` in the `crm.lead` views. */
const LEAD_LIST_VIEW_ID = 101;
/** View ids of the forecast kanban and list in the `crm.lead` views. */
const FORECAST_KANBAN_VIEW_ID = 301;
const FORECAST_LIST_VIEW_ID = 302;
const RECURRING_KANBAN_VIEW_ID = 303;
const ACTIVITY_LIST_VIEW_ID = 304;
const ACTIVITY_KANBAN_VIEW_ID = 305;
const LIMITED_KANBAN_VIEW_ID = 306;
const COLD_REPORT_GRAPH_VIEW_ID = 307;
/** "Mark Lost" action id, the `name` of the form's Lost button (`%(crm.crm_lead_lost_action)d`). */
const LOST_ACTION_ID = 21;
/** Ids of the actions the lead list buttons name (`%(...)d` in the real arches). */
const MASS_CONVERT_ACTION_ID = 22;
const MAIL_COMPOSE_ACTION_ID = 25;
const MASS_MAIL_ACTION_ID = 26;

/**
 * Lead list arch: the mass-action header buttons of the Leads list (Convert to
 * Opportunities, Mark Lost) and of the Opportunities list (Mark Lost, Email), the
 * row "Email" button and the tags with their colour popover.
 */
const LEAD_LIST_ARCH = /* xml */ `
    <list string="Opportunities" js_class="crm_list" multi_edit="1">
        <header>
            <button name="${MASS_CONVERT_ACTION_ID}" type="action" string="Convert to Opportunities"/>
            <button name="${LOST_ACTION_ID}" type="action" string="Mark Lost"/>
            <button name="${MASS_MAIL_ACTION_ID}" type="action" string="Email"/>
        </header>
        <field name="name"/>
        <field name="stage_id"/>
        <field name="tag_ids" widget="many2many_tags"
            options="{'color_field': 'color', 'on_tag_click': 'edit_color'}"/>
        <button name="${MAIL_COMPOSE_ACTION_ID}" type="action" string="Email" icon="fa-envelope"/>
    </list>`;

/**
 * Lead form arch (`crm_lead_view_form`) with its DISABLE controls: Convert, Restore and
 * Lost in the header, the Schedule Meeting and Similar Leads smart buttons, the AI
 * switches of the wide and small-screen layouts, the predictive scoring tooltips, the
 * blacklist removal buttons, the partner and tags fields and the chatter.
 */
const LEAD_FORM_FULL_ARCH = /* xml */ `
    <form class="o_lead_opportunity_form" js_class="crm_form">
        <header>
            <button name="action_set_won_rainbowman" string="Won" type="object" class="oe_highlight"
                data-hotkey="w" title="Mark as won" data-available-offline="1"
                invisible="won_status == 'won' or type == 'lead' or not active"/>
            <button name="action_convert_to_opportunity" string="Convert to Opportunity" type="object"
                class="oe_highlight" invisible="type == 'opportunity' or not active" data-hotkey="v"/>
            <button name="action_restore" string="Restore" type="object" data-hotkey="x"
                invisible="won_status != 'lost'"/>
            <button name="${LOST_ACTION_ID}" string="Lost" type="action" data-hotkey="l" title="Mark as lost"
                invisible="won_status != 'pending' or not active"/>
            <field name="stage_id" widget="rotting_statusbar_duration"
                options="{'clickable': '1', 'fold_field': 'fold', 'crm_call_activity_type_id': ${CALL_ACTIVITY_TYPE_ID}}"
                invisible="type == 'lead'" readonly="won_status == 'lost' or not active"/>
        </header>
        <sheet>
            <field name="won_status" invisible="1"/>
            <field name="active" invisible="1"/>
            <field name="type" invisible="1"/>
            <field name="is_automated_probability" invisible="1"/>
            <div class="oe_button_box" name="button_box">
                <button name="action_schedule_meeting" type="object" class="oe_stat_button" icon="fa-calendar"
                    context="{'partner_id': partner_id}" invisible="not id or type == 'lead'">
                    <div class="o_stat_info">
                        <span class="o_stat_text"><field name="meeting_display_label"/></span>
                    </div>
                </button>
                <button name="action_show_potential_duplicates" type="object" class="oe_stat_button" icon="fa-star"
                    invisible="duplicate_lead_count &lt; 1">
                    <div class="o_stat_info">
                        <field name="duplicate_lead_count" class="o_stat_value"/>
                        <span class="o_stat_text">Similar Leads</span>
                    </div>
                </button>
            </div>
            <widget name="web_ribbon" title="Archived" bg_color="text-bg-danger" invisible="active or won_status in ['lost', 'won']"/>
            <widget name="web_ribbon" title="Lost" bg_color="text-bg-danger" invisible="won_status != 'lost'"/>
            <widget name="web_ribbon" title="Won" invisible="won_status != 'won'"/>
            <field name="name"/>
            <h2 class="d-none d-sm-flex d-touch-none align-items-end mb-4">
                <field name="expected_revenue"/>
                <a class="border-0 mx-1 p-0 mb-1 mb-md-0 btn btn-light" name="action_set_automated_probability"
                    role="button" type="object" invisible="is_automated_probability or won_status == 'lost'">
                    <img class="m-1 o_lead_opportunity_form_AI_switch_img" title="Switch to AI-computed probabilities"
                        aria-label="Switch to AI-computed probabilities" src="/crm/static/src/img/pls-tooltip-ai-icon.png" alt="AI"/>
                </a>
                <widget name="pls_tooltip_button" class="d-inline-block"
                    invisible="won_status != 'pending' or not is_automated_probability"/>
                <field name="probability" widget="float" readonly="won_status != 'pending'"/>
            </h2>
            <group class="d-flex d-sm-none d-touch-flex">
                <div class="d-flex align-items-baseline gap-2">
                    <widget name="pls_tooltip_button" invisible="won_status != 'pending' or not is_automated_probability"/>
                    <a class="btn btn-link" name="action_set_automated_probability" role="button" type="object"
                        invisible="is_automated_probability or won_status == 'lost'">
                        <img class="o_lead_opportunity_form_AI_switch_img mx-2" title="Switch to AI-computed probabilities"
                            aria-label="Switch to AI-computed probabilities" src="/crm/static/src/img/pls-tooltip-ai-icon.png" alt="AI"/>
                    </a>
                </div>
            </group>
            <group>
                <field name="partner_id" widget="res_partner_many2one"
                    context="{'default_name': contact_name, 'default_phone': phone, 'default_email': email_from}"/>
                <field name="contact_name"/>
                <field name="is_blacklisted" invisible="1"/>
                <field name="phone_blacklisted" invisible="1"/>
                <label for="email_from" class="oe_inline"/>
                <div class="o_row o_row_readonly">
                    <button name="mail_action_blacklist_remove" class="fa fa-ban text-danger"
                        title="This email is blacklisted for mass mailings. Click to unblacklist."
                        type="object" context="{'default_email': email_from}" invisible="not is_blacklisted"/>
                    <field name="email_from" string="Email" widget="email"/>
                </div>
                <label for="phone" class="oe_inline"/>
                <div class="o_row o_row_readonly">
                    <button name="phone_action_blacklist_remove" class="fa fa-ban text-danger"
                        title="This phone number is blacklisted for SMS Marketing. Click to unblacklist."
                        type="object" context="{'default_phone': phone}" invisible="not phone_blacklisted"/>
                    <field name="phone" widget="phone"/>
                </div>
                <field name="team_id"/>
                <field name="user_id"/>
                <field name="tag_ids" widget="many2many_tags"
                    options="{'color_field': 'color', 'on_tag_click': 'edit_color', 'no_create_edit': True}"/>
            </group>
            <field name="lead_properties" nolabel="1" columns="2"/>
        </sheet>
        <chatter reload_on_post="True"/>
    </form>`;

/**
 * Sales Teams dashboard (`sales_team.crm_team_view_kanban_dashboard` with the CRM
 * inherit `crm.crm_team_view_kanban_dashboard`): card click action; card menu with
 * the seven CRM `type="action"` links (View: team leads and pipeline; New: lead and
 * opportunity forms; Reporting: leads, pipeline and activity analyses), the
 * manager's colour picker and "Configuration" link (with the attributes the CRM
 * inherit adds); the unassigned-leads link and the team leader's avatar field (with
 * its quick-assign while no leader is set) on the card.
 */
const TEAM_DASHBOARD_ARCH = /* xml */ `
    <kanban class="o_crm_team_kanban" highlight_color="color" create="0" can_open="0"
        action="action_primary_channel_button" type="object">
        <field name="use_leads"/>
        <field name="use_opportunities"/>
        <templates>
            <t t-name="menu">
                <div class="container">
                    <div class="row">
                        <div name="manage_view" class="col-5">
                            <h5 role="menuitem" class="o_kanban_card_manage_title"><span>View</span></h5>
                            <div t-if="record.use_leads.raw_value">
                                <a name="${TEAM_LEADS_ACTION_ID}" type="action">Leads</a>
                            </div>
                            <div t-if="record.use_opportunities.raw_value">
                                <a name="${TEAM_PIPELINE_ACTION_ID}" type="action">Opportunities</a>
                            </div>
                        </div>
                        <div name="manage_new" class="col-5">
                            <h5 role="menuitem" class="o_kanban_card_manage_title"><span>New</span></h5>
                            <div t-if="record.use_leads.raw_value">
                                <a name="${NEW_LEAD_ACTION_ID}" type="action">Leads</a>
                            </div>
                            <div t-if="record.use_opportunities.raw_value">
                                <a name="${NEW_OPPORTUNITY_ACTION_ID}" type="action">Opportunity</a>
                            </div>
                        </div>
                        <div name="manage_reports" class="col-5">
                            <h5 role="menuitem" class="o_kanban_card_manage_title"><span>Reporting</span></h5>
                            <div t-if="record.use_leads.raw_value">
                                <a name="${LEAD_SALESTEAM_REPORT_ACTION_ID}" type="action">Leads</a>
                            </div>
                            <div t-if="record.use_opportunities.raw_value">
                                <a name="${TEAM_REPORT_ACTION_ID}" type="action">Opportunities</a>
                            </div>
                            <div name="o_team_kanban_report_separator"/>
                            <div t-if="record.use_opportunities.raw_value">
                                <a name="${ACTIVITY_REPORT_TEAM_ACTION_ID}" type="action">Activities</a>
                            </div>
                        </div>
                    </div>
                    <div t-if="widget.editable" class="o_kanban_card_manage_settings row">
                        <div role="menuitem" aria-haspopup="true" class="col-8">
                            <field name="color" widget="kanban_color_picker"/>
                        </div>
                        <div role="menuitem" class="col-4">
                            <a class="dropdown-item" type="open"
                                t-att-class="widget.crm_offline ? 'o_disabled_offline pe-none' : ''"
                                t-att-aria-disabled="widget.crm_offline ? 'true' : false"
                                t-att-tabindex="widget.crm_offline ? -1 : false"
                                t-key="widget.crm_offline ? 'crm_offline' : 'crm_online'"
                                t-att-inert="widget.crm_offline ? '' : false">Configuration</a>
                        </div>
                    </div>
                </div>
            </t>
            <t t-name="card" class="flex-column justify-content-between">
                <div class="ms-2 me-3">
                    <field name="name" class="fw-bold fs-2"/>
                </div>
                <div class="crm_team_kanban_bottom d-flex align-items-center mt-5">
                    <a name="action_open_unassigned_opportunities" type="object" class="ms-2 me-auto"
                        invisible="not lead_unassigned_count">
                        <field name="lead_unassigned_count" class="me-1"/>Unassigned Leads
                    </a>
                    <field name="user_id" widget="many2one_avatar_user" class="ms-auto"/>
                </div>
            </t>
        </templates>
    </kanban>`;

/**
 * Pipeline kanban arch (`crm_case_kanban_view_leads`), grouped by stage.
 *
 * @param {Object} [options]
 * @param {number} [options.limit] records loaded per column
 * @param {boolean} [options.activities] adds the cards' `kanban_activity` button
 */
function pipelineArch({ limit = 40, activities = false } = {}) {
    // A single-line string interpolated in the arch: a multi-line template literal
    // nested in the arch template reaches the browser altered, and fails to parse.
    const activityField = activities
        ? '<field name="activity_ids" widget="kanban_activity" options="{\'crm_call_activity_type_id\': ' +
          CALL_ACTIVITY_TYPE_ID +
          '}"/>'
        : "";
    return /* xml */ `
        <kanban js_class="crm_mobile_pipeline" highlight_color="color" default_group_by="stage_id"
            archivable="false" limit="${limit}">
            <field name="stage_id"/>
            <field name="active"/>
            <field name="won_status"/>
            <templates>
                <t t-name="menu">
                    <t t-if="widget.editable"><a role="menuitem" type="open" class="dropdown-item">Edit</a></t>
                    <t t-if="widget.deletable"><a role="menuitem" type="delete" class="dropdown-item">Delete</a></t>
                    <div role="separator" class="dropdown-divider"/>
                    <field name="color" widget="kanban_color_picker"/>
                </t>
                <t t-name="card">
                    <field class="fw-bold fs-5" name="name"/>
                    <field name="expected_revenue"/>
                    ${activityField}
                </t>
            </templates>
        </kanban>`;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Routes of the lead root loads. Offline, a root load is served from the framework's
 * RPC cache and its network fallback raises the lost request
 * (`Connection to "<route>" couldn't be established or was interrupted`), as the
 * framework's own offline tests count it.
 *
 * Offline cache-fallback and startup errors are declared explicitly. Tests injecting
 * server failures also declare those failures; each assertion checks the exact
 * expected error and unexpected CRM failures remain visible.
 */
const LEAD_GROUPS_LOAD = "/web/dataset/call_kw/crm.lead/web_read_group";
const LEAD_RECORD_LOAD = "/web/dataset/call_kw/crm.lead/web_read";
const LEAD_LIST_LOAD = "/web/dataset/call_kw/crm.lead/web_search_read";

/**
 * Genuine framework queue entries of a model, in replay order.
 *
 * @param {string} model
 * @returns {{key: string, value: {model: string, method: string, args: any[], kwargs: Object, extras: Object}}[]}
 */
function queued(model) {
    return Object.values(getService(OfflinePlugin)._ormToSync())
        .filter((entry) => entry.value.model === model)
        .sort((a, b) => (a.value.extras?.timeStamp || 0) - (b.value.extras?.timeStamp || 0));
}

/** `{model, method, args, kwargs}` of the queued entries of `model`, in replay order. */
function queuedCalls(model) {
    return queued(model).map(({ value }) => ({
        model: value.model,
        method: value.method,
        args: value.args,
        kwargs: value.kwargs,
    }));
}

/**
 * The context a view sends with the calls of its records: the opening action's
 * context, the session user's context and the keys the view adds itself (such as a
 * pipeline column's default stage).
 *
 * @param {Object} [actionContext]
 * @param {Object} [viewKeys]
 * @returns {Object}
 */
function callContext(actionContext = {}, viewKeys = {}) {
    return { ...actionContext, ...user.context, ...viewKeys };
}

/**
 * The context of a call the view queues offline: its `callContext`, plus the id of
 * the session user, who queued it (`CRM_OFFLINE_UID_KEY`).
 *
 * @param {Object} [actionContext]
 * @param {Object} [viewKeys]
 * @returns {Object}
 */
function queuedContext(actionContext = {}, viewKeys = {}) {
    return { ...callContext(actionContext, viewKeys), [CRM_OFFLINE_UID_KEY]: serverState.userId };
}

/**
 * The payload of an ORM call as the mock server receives it, `{model, method, args,
 * kwargs}`, copied when it arrives and without the mock server's keyword-argument flag.
 *
 * @param {{model: string, method: string, args: any[], kwargs: Object}} params
 */
function callPayload({ model, method, args, kwargs }) {
    return JSON.parse(JSON.stringify({ model, method, args, kwargs }));
}

/**
 * Steps the payload (`callPayload`) of every call of `method` on `model` that reaches
 * the mock server, online or replayed.
 *
 * @param {string} model
 * @param {string} method
 */
function stepCalls(model, method) {
    onRpc(model, method, (params) => {
        expect.step(callPayload(params));
    });
}

/**
 * Steps every ORM, button and action-load route (`/web/dataset/call_kw/<model>/<method>`,
 * `/web/dataset/call_button/<model>/<method>` and `/web/action/load`), online and
 * offline, so a test can prove a request was, or was not, issued. Must be called after
 * `mockOffline()`: the listener registered last runs first, so it also sees the
 * offline attempts.
 *
 * @param {(route: string) => boolean} [filter]
 */
function stepRoutes(filter = () => true) {
    const state = { active: true };
    onRpc("/*", (request) => {
        const route = new URL(request.url).pathname;
        const isStepped =
            /^\/web\/dataset\/call_(kw|button)\//.test(route) || route === "/web/action/load";
        if (state.active && isStepped && filter(route)) {
            expect.step(route);
        }
    });
    return state;
}

/** Opens the offline systray dropdown (desktop label or mobile icon). */
async function openSystray() {
    await contains(".o_menu_systray .o_offline_systray").click();
}

/**
 * Restores the connection and lets the framework replay its queue (one call per
 * second) and the views settle.
 *
 * @param {(offline: boolean) => Promise<void>} setOffline
 */
async function reconnect(setOffline) {
    await setOffline(false);
    await runAllTimers();
    await animationFrame();
}

/** Runs the framework's start-up `_syncORM`, scheduled 3 s after the plugin starts. */
async function flushStartupSync() {
    await runAllTimers();
    await animationFrame();
}

/** Script the partner enrichment source lazy-loads before its first lookup. */
const JSVAT_SCRIPT = "/partner_autocomplete/static/lib/jsvat.js";

/**
 * Template of `PartnerAutoCompleteStandIn`, registered for each test: a primary
 * inherit of `web.AutoComplete` adding the partner autocomplete's "Search Worldwide"
 * row, rendered below the options unless `shouldSearchWorldwide` is set.
 */
const PARTNER_AUTOCOMPLETE_TEMPLATE = "crm.test.OfflinePartnerAutoComplete";
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
 * Stand-in for the `res_partner_many2one` widget (`PartnerAutoCompleteMany2one`),
 * registered under that arch name for each test. Its addon, `partner_autocomplete`,
 * auto-installs with CRM's dependencies but is outside CRM's `depends`, so the
 * unit-test module set of `@crm` does not load it, and CRM (this file included)
 * imports nothing from it. The stand-in keeps the widget's contract: a many2one whose
 * autocomplete renders the "Search Worldwide" row, and whose `otherSources` adds the
 * paid enrichment source, which loads the `jsvat` script (stepped here) then calls
 * `res.partner.autocomplete_by_name` with the country to search (`false` for the
 * company's, `0` worldwide), for queries longer than two characters and only when
 * the field can create.
 */
class EnrichmentPartnerMany2One extends Component {
    static template = xml`<Many2One t-props="this.m2oProps"/>`;
    static components = { Many2One: PartnerMany2OneStandIn };
    static props = { ...Many2OneField.props };

    setup() {
        this.orm = useService("orm");
    }

    get m2oProps() {
        return { ...computeM2OProps(this.props), otherSources: this.sources };
    }

    get sources() {
        if (!this.props.canCreate) {
            return [];
        }
        return [
            {
                options: async (request, shouldSearchWorldwide) => {
                    if (!request || request.length <= 2) {
                        return [];
                    }
                    expect.step(JSVAT_SCRIPT);
                    const queryCountryId = shouldSearchWorldwide ? 0 : false;
                    const suggestions = await this.orm.silent.call(
                        "res.partner",
                        "autocomplete_by_name",
                        [request, queryCountryId]
                    );
                    return suggestions.map((suggestion) => ({
                        cssClass: "partner_autocomplete_dropdown_many2one",
                        data: suggestion,
                        label: suggestion.name,
                        onSelect: () => expect.step(`enrichment selected: ${suggestion.name}`),
                    }));
                },
                placeholder: "Searching Autocomplete...",
            },
        ];
    }
}

beforeEach(() => {
    patchWithCleanup(AnimatedNumber, { enableAnimations: false });
    after(
        registerTemplate(
            PARTNER_AUTOCOMPLETE_TEMPLATE,
            "/crm/static/tests/crm_offline.test.js",
            PARTNER_AUTOCOMPLETE_ARCH
        )
    );
    // Restored after each test with the rest of the registries.
    registry
        .category("fields")
        .add("res_partner_many2one", buildM2OFieldDescription(EnrichmentPartnerMany2One));
});

/**
 * Selects a stage in the lead form statusbar: an inline button on desktop, the
 * all-stages dropdown item on the mobile preset.
 *
 * @param {number} stageId
 * @param {string} stageName
 */
async function selectStage(stageId, stageName) {
    if (isSmall()) {
        await contains(".o_statusbar_status button.dropdown-toggle").click();
        await contains(`.o-dropdown--menu .dropdown-item:contains(${stageName})`).click();
    } else {
        await contains(`.o_statusbar_status button[data-value='${stageId}']`).click();
    }
}

/**
 * Steps every `get_rainbowman_message` call that reaches the mock server's ORM
 * dispatch, which an online lookup does. Offline requests are answered before that
 * dispatch: `stepRainbowmanAttempts` sees them.
 */
function stepRainbowman() {
    onRpc("crm.lead", "get_rainbowman_message", ({ parent }) => {
        expect.step("get_rainbowman_message");
        return parent();
    });
}

/** Route of the `crm.lead.get_rainbowman_message` lookup. */
const RAINBOWMAN_ROUTE = "/web/dataset/call_kw/crm.lead/get_rainbowman_message";

/**
 * Steps every attempted rainbowman lookup request (`RAINBOWMAN_ROUTE`) as its route,
 * including one answered offline. Must be called after `mockOffline()` (see
 * `stepRoutes`).
 */
function stepRainbowmanAttempts() {
    stepRoutes((route) => route === RAINBOWMAN_ROUTE);
}

// -----------------------------------------------------------------------------
// SKIP: rainbowman lookup
// -----------------------------------------------------------------------------

test("[Offline] form stage change save skips rainbowman lookup", async () => {
    const setOffline = mockOffline();
    stepRainbowmanAttempts();
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        arch: LEAD_FORM_ARCH,
        config: { actionId: 1 },
    });
    await flushStartupSync();

    await setOffline(true);
    await selectStage(STAGE_WON, "Won");
    await contains(".o_form_button_save").click();

    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_WON }],
            kwargs: { context: queuedContext(), specification: {} },
        },
    ]);
    expect(".o_form_button_save").not.toBeVisible();
    expect(".o_reward").toHaveCount(0);
    expect.verifySteps([]);
});

test("[Online] form stage change save issues rainbowman lookup", async () => {
    stepRainbowman();
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        arch: LEAD_FORM_ARCH,
        config: { actionId: 1 },
    });

    await selectStage(STAGE_WON, "Won");
    await contains(".o_form_button_save").click();

    expect.verifySteps(["get_rainbowman_message"]);
    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(1);
});

test.tags("desktop");
test("[Offline] kanban stage move skips rainbowman lookup", async () => {
    const setOffline = mockOffline();
    stepRainbowmanAttempts();
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        arch: pipelineArch(),
        groupBy: ["stage_id"],
        config: { actionId: 1 },
    });
    await flushStartupSync();

    await setOffline(true);
    await contains(".o_kanban_group:eq(0) .o_kanban_record:contains(Lead 1)").dragAndDrop(
        ".o_kanban_group:eq(2)"
    );

    expect(".o_kanban_group:eq(2) .o_kanban_record:contains(Lead 1)").toHaveCount(1);
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_WON }],
            kwargs: {
                context: queuedContext({}, { default_stage_id: STAGE_NEW }),
                specification: {},
            },
        },
    ]);
    expect(".o_reward").toHaveCount(0);
    expect.verifySteps([]);
});

test.tags("desktop");
test("[Online] kanban stage move issues rainbowman lookup", async () => {
    stepRainbowman();
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        arch: pipelineArch(),
        groupBy: ["stage_id"],
        config: { actionId: 1 },
    });

    await contains(".o_kanban_group:eq(0) .o_kanban_record:contains(Lead 1)").dragAndDrop(
        ".o_kanban_group:eq(2)"
    );

    expect.verifySteps(["get_rainbowman_message"]);
    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(1);
});

// -----------------------------------------------------------------------------
// QUEUE: lead, stage and team writes (framework queue, optimistic UI, replay)
// -----------------------------------------------------------------------------

/** Steps the payload of the `web_save` calls of `model` that reach the mock server. */
function stepWebSave(model = "crm.lead") {
    stepCalls(model, "web_save");
}

/**
 * The specification an online save of the lead form (`LEAD_FORM_ARCH`) reads the lead
 * back with: the fields the form loads, which on a small screen include the activity
 * rows of the phone variant. A queued or replayed save reads nothing back.
 *
 * @returns {Object}
 */
function leadFormReadBack() {
    const specification = {
        active: {},
        display_name: {},
        duration_tracking: {},
        email_from: {},
        expected_revenue: {},
        name: {},
        partner_email_update: {},
        partner_phone_update: {},
        phone: {},
        probability: {},
        stage_id: { fields: { display_name: {} } },
        team_id: { fields: { display_name: {} } },
        type: {},
        user_id: { fields: { display_name: {} } },
        won_status: {},
    };
    if (isSmall()) {
        specification.activity_ids = {
            fields: {
                activity_type_id: { fields: { display_name: {} } },
                date_deadline: {},
                state: {},
                summary: {},
                user_id: { fields: { display_name: {} } },
            },
            limit: CRM_MOBILE_ACTIVITY_LIMIT,
        };
    }
    return specification;
}

test("[Offline] queued lead write includes forced email and phone", async () => {
    stepWebSave();
    const setOffline = mockOffline();
    const { env } = await makeMockServer();
    const partnerId = env["res.partner"].create({
        name: "Azure Interior",
        email: "azure@example.com",
        phone: "+32 470 11 22 33",
    });
    env["crm.lead"].write([2], {
        partner_id: partnerId,
        email_from: "azure@example.com",
        phone: "+32 470 11 22 33",
        partner_email_update: true,
        partner_phone_update: true,
    });
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 2,
        arch: LEAD_FORM_ARCH,
        config: { actionId: 1 },
    });
    await flushStartupSync();

    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 2 (offline)");
    await contains(".o_form_button_save").click();

    const save = {
        model: "crm.lead",
        method: "web_save",
        args: [
            [2],
            {
                name: "Lead 2 (offline)",
                email_from: "azure@example.com",
                phone: "+32 470 11 22 33",
            },
        ],
        kwargs: { context: queuedContext(), specification: {} },
    };
    expect(queuedCalls("crm.lead")).toEqual([save]);
    expect.verifySteps([]);

    await reconnect(setOffline);
    await expect.waitForSteps([save]);
    expect(queued("crm.lead")).toEqual([]);
    expect(env["crm.lead"].browse(2)[0]).toMatchObject({
        name: "Lead 2 (offline)",
        email_from: "azure@example.com",
        phone: "+32 470 11 22 33",
    });
});

/** View ids of `LEAD_CONTACT_LIST_ARCH` and `LEAD_CONTACT_FORM_ARCH`, registered per test. */
const LEAD_CONTACT_LIST_VIEW_ID = 502;
const LEAD_CONTACT_FORM_VIEW_ID = 503;

/**
 * Lead list showing each lead's partner: an online visit caches the partners it shows
 * in the relational-field cache, which the partner field searches offline.
 */
const LEAD_CONTACT_LIST_ARCH = /* xml */ `
    <list>
        <field name="name"/>
        <field name="partner_id"/>
    </list>`;

/**
 * Lead form with the contact fields of `crm_lead_view_form`: the partner and the flags
 * the CRM save reads to force the email and phone, and the phone widget with the
 * sanitized and formatted numbers it dials and shows. The server marks `partner_id`
 * and `phone` as `on_change` fields, as computed fields depend on them; the mock
 * server defines no onchange for them, so the arch carries the attribute.
 */
const LEAD_CONTACT_FORM_ARCH = /* xml */ `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="partner_id" on_change="1"/>
            <field name="partner_email_update" invisible="1"/>
            <field name="partner_phone_update" invisible="1"/>
            <field name="email_from"/>
            <field name="phone_sanitized" invisible="1"/>
            <field name="phone_formatted" invisible="1"/>
            <field name="phone" widget="phone" on_change="1"/>
        </sheet>
    </form>`;

/** Leads list and form of the contact fields (`LEAD_CONTACT_*_ARCH`). */
const LEAD_CONTACT_ACTION = {
    id: 46,
    xml_id: "crm.crm_lead_all_leads",
    name: "Leads",
    res_model: "crm.lead",
    views: [
        [LEAD_CONTACT_LIST_VIEW_ID, "list"],
        [LEAD_CONTACT_FORM_VIEW_ID, "form"],
    ],
};

/**
 * Online, opens the leads list of the contact fields, then the lead named `name` in
 * its form: both are cached, with the partners the list shows.
 *
 * @param {string} name
 */
async function openLeadContactForm(name) {
    registerInlineViewArchs("crm.lead", {
        [`list,${LEAD_CONTACT_LIST_VIEW_ID}`]: LEAD_CONTACT_LIST_ARCH,
        [`form,${LEAD_CONTACT_FORM_VIEW_ID}`]: LEAD_CONTACT_FORM_ARCH,
    });
    defineActions([LEAD_CONTACT_ACTION]);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEAD_CONTACT_ACTION.id);
    await contains(`.o_data_row:contains(${name}) .o_data_cell`).click();
    await flushStartupSync();
}

test("[Offline] partner change queues no stale forced email and phone", async () => {
    stepWebSave();
    const setOffline = mockOffline();
    const { env } = await makeMockServer();
    const oldPartnerId = env["res.partner"].create({
        name: "Old Partner",
        email: "old.partner@example.com",
        phone: "+32 470 10 10 10",
    });
    const newPartnerId = env["res.partner"].create({
        name: "New Partner",
        email: "new.partner@example.com",
        phone: "+32 470 99 99 99",
    });
    // The lead's own email and phone differ from its partner's: both flags are set.
    env["crm.lead"].write([2], {
        partner_id: oldPartnerId,
        email_from: "lead.own@example.com",
        phone: "+32 494 12 12 12",
        partner_email_update: true,
        partner_phone_update: true,
    });
    // Another lead of the new partner, so the list caches that partner.
    env["crm.lead"].write([3], { partner_id: newPartnerId });
    await openLeadContactForm("Lead 2");
    expect.verifySteps([]);

    // Offline, the new partner is selected from the cache. Its onchange is lost, so
    // the flags loaded for the old partner must not force the lead's email and phone,
    // which the server would write over the new partner's on replay. The server
    // computes them from the new partner instead, as the online onchange does.
    await setOffline(true);
    await searchPartner("New");
    await contains(`${PARTNER_OPTIONS}:contains(New Partner)`).click();
    expect(PARTNER_INPUT).toHaveValue("New Partner");
    await contains(".o_form_button_save").click();
    const kwargs = { context: queuedContext(), specification: {} };
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[2], { partner_id: newPartnerId }],
            kwargs,
        },
    ]);

    // A later offline save of the lead adds its own edit, still with nothing forced.
    await contains(".o_field_widget[name=name] input").edit("Lead 2 renamed");
    await contains(".o_form_button_save").click();
    const save = {
        model: "crm.lead",
        method: "web_save",
        args: [[2], { partner_id: newPartnerId, name: "Lead 2 renamed" }],
        kwargs,
    };
    expect(queuedCalls("crm.lead")).toEqual([save]);
    expect.verifySteps([]);

    // On reconnection the queued save replays as queued, and nothing else is saved:
    // the mock server, which computes nothing, keeps the lead's email and phone.
    await reconnect(setOffline);
    await expect.waitForSteps([save]);
    await runAllTimers();
    await animationFrame();
    expect.verifySteps([]);
    expect(queued("crm.lead")).toEqual([]);
    expect(env["crm.lead"].browse(2)[0]).toMatchObject({
        name: "Lead 2 renamed",
        partner_id: newPartnerId,
        email_from: "lead.own@example.com",
        phone: "+32 494 12 12 12",
    });
});

/**
 * Gives lead 2 the partner "Old Partner" and its own email and phone, which differ
 * from the partner's, so both flags of the CRM force-save are set, and makes "New
 * Partner" the partner of lead 3, so the leads list caches it for an offline search.
 *
 * @param {Object} env the mock server environment
 * @returns {number} the id of "New Partner"
 */
function setupLeadOwnContacts(env) {
    const oldPartnerId = env["res.partner"].create({
        name: "Old Partner",
        email: "old.partner@example.com",
        phone: "+32 470 10 10 10",
    });
    const newPartnerId = env["res.partner"].create({
        name: "New Partner",
        email: "new.partner@example.com",
        phone: "+32 470 99 99 99",
    });
    env["crm.lead"].write([2], {
        partner_id: oldPartnerId,
        email_from: "lead.own@example.com",
        phone: "+32 494 12 12 12",
        partner_email_update: true,
        partner_phone_update: true,
    });
    env["crm.lead"].write([3], { partner_id: newPartnerId });
    return newPartnerId;
}

/** Selects the cached "New Partner" in the lead form's partner field. */
async function selectNewPartner() {
    await searchPartner("New");
    await contains(`${PARTNER_OPTIONS}:contains(New Partner)`).click();
    expect(PARTNER_INPUT).toHaveValue("New Partner");
}

test("[Offline] partner change after a forced save does not replay the forced email and phone", async () => {
    stepWebSave();
    const setOffline = mockOffline();
    const { env } = await makeMockServer();
    const newPartnerId = setupLeadOwnContacts(env);
    await openLeadContactForm("Lead 2");
    expect.verifySteps([]);

    // Offline, a save of the lead with its partner forces its email and phone.
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 2 renamed");
    await contains(".o_form_button_save").click();
    const kwargs = { context: queuedContext(), specification: {} };
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [
                [2],
                {
                    name: "Lead 2 renamed",
                    email_from: "lead.own@example.com",
                    phone: "+32 494 12 12 12",
                },
            ],
            kwargs,
        },
    ]);

    // Another partner is then chosen offline. The lead's saves are merged into one
    // queued write, which no longer forces the email and phone of the previous
    // partner: replayed, they would overwrite the new partner's.
    await selectNewPartner();
    await contains(".o_form_button_save").click();
    const save = {
        model: "crm.lead",
        method: "web_save",
        args: [[2], { name: "Lead 2 renamed", partner_id: newPartnerId }],
        kwargs,
    };
    expect(queuedCalls("crm.lead")).toEqual([save]);
    expect.verifySteps([]);

    // On reconnection the queued write replays as queued, and nothing else is saved.
    await reconnect(setOffline);
    await expect.waitForSteps([save]);
    await runAllTimers();
    await animationFrame();
    expect.verifySteps([]);
    expect(queued("crm.lead")).toEqual([]);
    expect(env["crm.lead"].browse(2)[0]).toMatchObject({
        name: "Lead 2 renamed",
        partner_id: newPartnerId,
    });
});

test("[Offline] partner change on a reopened lead drops the restored forced email and phone", async () => {
    // Offline root loads served from the cache: back to the list and the reopened lead.
    expect.errors(2);
    stepWebSave();
    const setOffline = mockOffline();
    const { env } = await makeMockServer();
    const newPartnerId = setupLeadOwnContacts(env);
    await openLeadContactForm("Lead 2");

    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 2 renamed");
    await contains(".o_form_button_save").click();
    const kwargs = { context: queuedContext(), specification: {} };
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [
                [2],
                {
                    name: "Lead 2 renamed",
                    email_from: "lead.own@example.com",
                    phone: "+32 494 12 12 12",
                },
            ],
            kwargs,
        },
    ]);

    // Reopened offline, the lead's queued save is restored in the form, forced email
    // and phone included. A new partner then drops them from the queued write.
    await goBack();
    await contains(".o_data_row:contains(Lead 2) .o_data_cell").click();
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 2 renamed");
    expect(".o_field_widget[name=email_from] input").toHaveValue("lead.own@example.com");
    await selectNewPartner();
    await contains(".o_form_button_save").click();
    const save = {
        model: "crm.lead",
        method: "web_save",
        args: [[2], { name: "Lead 2 renamed", partner_id: newPartnerId }],
        kwargs,
    };
    expect(queuedCalls("crm.lead")).toEqual([save]);
    expect.verifySteps([]);

    await reconnect(setOffline);
    await expect.waitForSteps([save]);
    await runAllTimers();
    await animationFrame();
    expect.verifySteps([]);
    expect(queued("crm.lead")).toEqual([]);
    expect.verifyErrors([LEAD_LIST_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] email typed before an offline partner change is superseded by the partner", async () => {
    stepWebSave();
    const setOffline = mockOffline();
    const { env } = await makeMockServer();
    const newPartnerId = setupLeadOwnContacts(env);
    await openLeadContactForm("Lead 2");
    const emailInput = ".o_field_widget[name=email_from] input";

    // Online, the partner onchange replaces an email typed before it with the
    // partner's. Offline, the field shows the stored email again, and the save
    // writes the partner only: on replay the server derives the lead's email from
    // the new partner, instead of writing the typed one over the partner's.
    await setOffline(true);
    await contains(emailInput).edit("lead.typed@example.com");
    await selectNewPartner();
    expect(emailInput).toHaveValue("lead.own@example.com");
    await contains(".o_form_button_save").click();
    expect(emailInput).toHaveValue("lead.own@example.com");
    const save = {
        model: "crm.lead",
        method: "web_save",
        args: [[2], { partner_id: newPartnerId }],
        kwargs: { context: queuedContext(), specification: {} },
    };
    expect(queuedCalls("crm.lead")).toEqual([save]);
    expect.verifySteps([]);

    await reconnect(setOffline);
    await expect.waitForSteps([save]);
    await runAllTimers();
    await animationFrame();
    expect.verifySteps([]);
    expect(queued("crm.lead")).toEqual([]);
    expect(env["crm.lead"].browse(2)[0]).toMatchObject({
        email_from: "lead.own@example.com",
        partner_id: newPartnerId,
        phone: "+32 494 12 12 12",
    });
    expect(env["res.partner"].browse(newPartnerId)[0]).toMatchObject({
        email: "new.partner@example.com",
        phone: "+32 470 99 99 99",
    });
});

test("[Offline] email saved before an offline partner change is superseded by the partner", async () => {
    stepWebSave();
    const setOffline = mockOffline();
    const { env } = await makeMockServer();
    const newPartnerId = setupLeadOwnContacts(env);
    await openLeadContactForm("Lead 2");
    const emailInput = ".o_field_widget[name=email_from] input";
    const kwargs = { context: queuedContext(), specification: {} };

    // Offline, a saved email is queued, with the phone forced for the partner.
    await setOffline(true);
    await contains(emailInput).edit("lead.typed@example.com");
    await contains(".o_form_button_save").click();
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[2], { email_from: "lead.typed@example.com", phone: "+32 494 12 12 12" }],
            kwargs,
        },
    ]);

    // A partner chosen afterwards supersedes it: the field shows the stored email
    // again, also once saved, and the merged queued write holds the partner only.
    await selectNewPartner();
    expect(emailInput).toHaveValue("lead.own@example.com");
    await contains(".o_form_button_save").click();
    expect(emailInput).toHaveValue("lead.own@example.com");
    const save = {
        model: "crm.lead",
        method: "web_save",
        args: [[2], { partner_id: newPartnerId }],
        kwargs,
    };
    expect(queuedCalls("crm.lead")).toEqual([save]);
    expect.verifySteps([]);

    await reconnect(setOffline);
    await expect.waitForSteps([save]);
    await runAllTimers();
    await animationFrame();
    expect.verifySteps([]);
    expect(queued("crm.lead")).toEqual([]);
    expect(env["crm.lead"].browse(2)[0]).toMatchObject({
        email_from: "lead.own@example.com",
        partner_id: newPartnerId,
    });
});

test("[Offline] email typed after an offline partner change is kept", async () => {
    stepWebSave();
    const setOffline = mockOffline();
    const { env } = await makeMockServer();
    const newPartnerId = setupLeadOwnContacts(env);
    await openLeadContactForm("Lead 2");
    const emailInput = ".o_field_widget[name=email_from] input";
    const kwargs = { context: queuedContext(), specification: {} };

    // Offline, an email typed after the partner change is an edit of the user, which
    // the save keeps; the phone, which nothing changed, is not forced.
    await setOffline(true);
    await selectNewPartner();
    expect(emailInput).toHaveValue("lead.own@example.com");
    await contains(emailInput).edit("lead.typed@example.com");
    await contains(".o_form_button_save").click();
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[2], { partner_id: newPartnerId, email_from: "lead.typed@example.com" }],
            kwargs,
        },
    ]);

    // A later save of the lead keeps the queued email.
    await contains(".o_field_widget[name=name] input").edit("Lead 2 renamed");
    await contains(".o_form_button_save").click();
    expect(emailInput).toHaveValue("lead.typed@example.com");
    const save = {
        model: "crm.lead",
        method: "web_save",
        args: [
            [2],
            {
                partner_id: newPartnerId,
                email_from: "lead.typed@example.com",
                name: "Lead 2 renamed",
            },
        ],
        kwargs,
    };
    expect(queuedCalls("crm.lead")).toEqual([save]);
    expect.verifySteps([]);

    await reconnect(setOffline);
    await expect.waitForSteps([save]);
    await runAllTimers();
    await animationFrame();
    expect.verifySteps([]);
    expect(queued("crm.lead")).toEqual([]);
    expect(env["crm.lead"].browse(2)[0]).toMatchObject({
        name: "Lead 2 renamed",
        email_from: "lead.typed@example.com",
        partner_id: newPartnerId,
        phone: "+32 494 12 12 12",
    });
});

test("[Offline] online save after an offline partner change writes no stale forced email and phone", async () => {
    // Offline root loads served from the cache: back to the list and the reopened lead.
    expect.errors(2);
    const rejection = rejectReplay("crm.lead", "web_save", "Save refused");
    onRpc("crm.lead", "web_save", ({ args }) => {
        expect.step(`web_save ${JSON.stringify(args)}`);
    });
    const setOffline = mockOffline();
    const { env } = await makeMockServer();
    const newPartnerId = setupLeadOwnContacts(env);
    await openLeadContactForm("Lead 2");
    const forced = {
        name: "Lead 2 renamed",
        email_from: "lead.own@example.com",
        phone: "+32 494 12 12 12",
    };

    // Offline, a rename forces the email and phone into the queued save, which
    // reopening the lead restores into the form. A new partner is then chosen, and
    // its onchange is lost.
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 2 renamed");
    await contains(".o_form_button_save").click();
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[2], forced],
            kwargs: { context: queuedContext(), specification: {} },
        },
    ]);
    await goBack();
    await contains(".o_data_row:contains(Lead 2) .o_data_cell").click();
    expect(".o_field_widget[name=email_from] input").toHaveValue("lead.own@example.com");
    await selectNewPartner();

    // Back online, the queued save replays and is refused: it stays parked, and the
    // form keeps the changes restored from it.
    rejection.reject = true;
    await reconnect(setOffline);
    expectParked("crm.lead", "Save refused");
    expect.verifySteps([`web_save ${JSON.stringify([[2], forced])}`]);
    rejection.reject = false;

    // The save of the form, now online, writes the rename and the new partner only:
    // the email and phone forced for the previous partner would overwrite the new
    // partner's. The parked save no longer holds them either, and stays parked.
    await contains(".o_form_button_save").click();
    await expect.waitForSteps([
        `web_save ${JSON.stringify([[2], { name: "Lead 2 renamed", partner_id: newPartnerId }])}`,
    ]);
    expect(env["crm.lead"].browse(2)[0]).toMatchObject({
        name: "Lead 2 renamed",
        partner_id: newPartnerId,
        email_from: "lead.own@example.com",
        phone: "+32 494 12 12 12",
    });
    expectParked("crm.lead", "Save refused");
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[2], { name: "Lead 2 renamed" }],
            kwargs: { context: queuedContext(), specification: {} },
        },
    ]);
    expect.verifyErrors([LEAD_LIST_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] save as the connection returns writes and replays no stale forced email and phone", async () => {
    // Offline root loads served from the cache: back to the list and the reopened lead.
    expect.errors(2);
    onRpc("crm.lead", "web_save", ({ args }) => {
        expect.step(`web_save ${JSON.stringify(args)}`);
    });
    // The connection, which can come back before the framework notices it.
    const network = { down: false };
    onRpc("/*", () => {
        if (network.down) {
            return new Response("", { status: 502 });
        }
    });
    const { env } = await makeMockServer();
    const newPartnerId = setupLeadOwnContacts(env);
    await openLeadContactForm("Lead 2");

    // Offline, a rename forces the email and phone into the queued save, which
    // reopening the lead restores into the form. A new partner is then chosen, and
    // its onchange is lost.
    network.down = true;
    getService(OfflinePlugin).setOffline(true);
    await animationFrame();
    await contains(".o_field_widget[name=name] input").edit("Lead 2 renamed");
    await contains(".o_form_button_save").click();
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [
                [2],
                {
                    name: "Lead 2 renamed",
                    email_from: "lead.own@example.com",
                    phone: "+32 494 12 12 12",
                },
            ],
            kwargs: { context: queuedContext(), specification: {} },
        },
    ]);
    await goBack();
    await contains(".o_data_row:contains(Lead 2) .o_data_cell").click();
    await selectNewPartner();
    expect(getService(OfflinePlugin).isOffline()).toBe(true);

    // The connection is back, and the form is saved before the framework notices
    // it: the save is not sent ahead of the lead's queued save, whose replay would
    // then overwrite it, but queued with it, and the connection check it starts
    // replays that save once, with the rename and the new partner. It writes no
    // email and phone forced for the previous partner over the new partner's.
    network.down = false;
    await contains(".o_form_button_save").click();
    await expect.waitForSteps([
        `web_save ${JSON.stringify([[2], { name: "Lead 2 renamed", partner_id: newPartnerId }])}`,
    ]);
    await runAllTimers();
    await animationFrame();
    expect.verifySteps([]);
    expect(getService(OfflinePlugin).isOffline()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(env["crm.lead"].browse(2)[0]).toMatchObject({
        name: "Lead 2 renamed",
        partner_id: newPartnerId,
    });
    expect.verifyErrors([LEAD_LIST_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] replay reconciliation after an offline partner change writes no superseded email", async () => {
    onRpc("crm.lead", "web_save", ({ args }) => {
        expect.step(`web_save ${JSON.stringify(args)}`);
    });
    const setOffline = mockOffline();
    const { env } = await makeMockServer();
    const newPartnerId = setupLeadOwnContacts(env);
    await openLeadContactForm("Lead 2");
    const typed = { email_from: "lead.typed@example.com", phone: "+32 494 12 12 12" };

    // Offline, a saved email is queued; a partner chosen afterwards, without saving,
    // gives the field its stored email back.
    await setOffline(true);
    await contains(".o_field_widget[name=email_from] input").edit(typed.email_from);
    await contains(".o_form_button_save").click();
    await selectNewPartner();
    expect(".o_field_widget[name=email_from] input").toHaveValue("lead.own@example.com");

    // The replay writes the queued email. The reconciliation then reads the lead and
    // saves the new partner only: the email the partner change superseded is not
    // written over the new partner's, although the lead read back holds another one.
    await reconnect(setOffline);
    await runAllTimers();
    await animationFrame();
    expect.verifySteps([
        `web_save ${JSON.stringify([[2], typed])}`,
        `web_save ${JSON.stringify([[2], { partner_id: newPartnerId }])}`,
    ]);
    expect(queued("crm.lead")).toEqual([]);
    expect(env["crm.lead"].browse(2)[0]).toMatchObject({
        partner_id: newPartnerId,
        email_from: typed.email_from,
    });
});

test("[Offline] partner change saved after a later write of the lead queues no stale forced email and phone", async () => {
    // Offline root loads served from the cache: back to the list and the reopened lead.
    expect.errors(2);
    stepWebSave();
    const setOffline = mockOffline();
    const { env } = await makeMockServer();
    const newPartnerId = setupLeadOwnContacts(env);
    await openLeadContactForm("Lead 2");
    const kwargs = { context: queuedContext(), specification: {} };
    const phoneInput = ".o_field_widget[name=phone] input";

    // T1: offline, a rename forces the lead's email and phone for its partner.
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 2 renamed");
    await contains(".o_form_button_save").click();
    const [formSave] = queued("crm.lead");
    expect(formSave.value.args).toEqual([
        [2],
        { name: "Lead 2 renamed", email_from: "lead.own@example.com", phone: "+32 494 12 12 12" },
    ]);
    // T2 = T1 + 1 min: the lead's form of another action (another Record) saves another
    // name and phone, queued as the framework queues a form save.
    const otherSave = getService(OfflinePlugin).scheduleORM(
        "crm.lead",
        "web_save",
        [[2], { name: "Lead 2 elsewhere", phone: "+32 470 55 55 55" }],
        kwargs,
        {
            extras: {
                actionId: TEAM_LEADS_ACTION_ID,
                actionName: TEAM_LEADS_ACTION.name,
                viewType: "form",
                displayName: "Lead 2 elsewhere",
                timeStamp: formSave.value.extras.timeStamp + 60_000,
                changes: { name: "Lead 2 elsewhere", phone: "+32 470 55 55 55" },
                originalValues: { name: "Lead 2", phone: "+32 494 12 12 12" },
            },
        }
    );

    // A new partner is chosen, then a phone typed after it is saved. The later write
    // also writes the phone and the name the form's queued save holds: that save keeps
    // its time, and the phone is queued again after the later write, in a follow-up
    // write. Neither the queued save nor the follow-up holds the email and phone
    // forced for the previous partner, which would overwrite the new partner's.
    await selectNewPartner();
    await contains(phoneInput).edit("+32 470 77 77 77", { confirm: "tab" });
    await contains(".o_form_button_save").click();
    expect(".o_field_widget[name=email_from] input").toHaveValue("lead.own@example.com");
    expect(phoneInput).toHaveValue("+32 470 77 77 77");
    const formWrite = {
        model: "crm.lead",
        method: "web_save",
        args: [
            [2],
            { name: "Lead 2 renamed", phone: "+32 470 77 77 77", partner_id: newPartnerId },
        ],
        kwargs,
    };
    const laterWrite = {
        model: "crm.lead",
        method: "web_save",
        args: [[2], { name: "Lead 2 elsewhere", phone: "+32 470 55 55 55" }],
        kwargs,
    };
    const followUp = {
        model: "crm.lead",
        method: "web_save",
        args: [[2], { phone: "+32 470 77 77 77" }],
        kwargs,
    };
    expect(queuedCalls("crm.lead")).toEqual([formWrite, laterWrite, followUp]);
    const entries = queued("crm.lead");
    expect(entries.slice(0, 2).map(({ key }) => key)).toEqual([formSave.key, otherSave]);
    expect(entries[0].value.extras.timeStamp).toBe(formSave.value.extras.timeStamp);
    expect(entries[2].value.extras.crmFollowUp).toBe(true);

    // Reopened offline, the lead shows the phone of its last queued write.
    await goBack();
    await contains(".o_data_row:contains(Lead 2) .o_data_cell").click();
    expect(phoneInput).toHaveValue("+32 470 77 77 77");
    expect(PARTNER_INPUT).toHaveValue("New Partner");
    expect(queuedCalls("crm.lead")).toEqual([formWrite, laterWrite, followUp]);
    expect.verifySteps([]);

    // On reconnection the three writes replay in order, and nothing else is saved.
    await reconnect(setOffline);
    await expect.waitForSteps([formWrite, laterWrite, followUp]);
    await runAllTimers();
    await animationFrame();
    expect.verifySteps([]);
    expect(queued("crm.lead")).toEqual([]);
    expect(env["crm.lead"].browse(2)[0]).toMatchObject({
        name: "Lead 2 elsewhere",
        partner_id: newPartnerId,
        email_from: "lead.own@example.com",
        phone: "+32 470 77 77 77",
    });
    expect(env["res.partner"].browse(newPartnerId)[0]).toMatchObject({
        email: "new.partner@example.com",
        phone: "+32 470 99 99 99",
    });
    expect.verifyErrors([LEAD_LIST_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] phone edit shows the saved number", async () => {
    // Offline root loads served from the cache: back to the list and the reopened lead.
    expect.errors(2);
    const phoneFields = [];
    patchWithCleanup(PhoneField.prototype, {
        setup() {
            super.setup(...arguments);
            phoneFields.push(this);
        },
    });
    patchWithCleanup(browser, { open: (url) => expect.step(`open ${url}`) });
    const setOffline = mockOffline();
    const { env } = await makeMockServer();
    env["crm.lead"].write([2], {
        phone: "+32 470 12 34 56",
        phone_formatted: "+32 470 12 34 56",
        phone_sanitized: "+32470123456",
    });
    await openLeadContactForm("Lead 2");
    const phoneInput = ".o_field_widget[name=phone] input";
    expect(phoneInput).toHaveValue("+32 470 12 34 56");
    expect(phoneFields.at(-1).phoneHref).toBe("tel:+32470123456");

    // Offline the onchange of the new number is lost: the loaded formatted and
    // sanitized numbers are dropped, so the field shows and dials the new number.
    await setOffline(true);
    await contains(phoneInput).edit("+32 470 65 43 21", { confirm: "tab" });
    expect(phoneInput).toHaveValue("+32 470 65 43 21");
    expect(phoneFields.at(-1).phoneHref).toBe("tel:+32470654321");
    await contains(".o_form_button_save").click();
    expect(phoneInput).toHaveValue("+32 470 65 43 21");
    expect(phoneFields.at(-1).phoneHref).toBe("tel:+32470654321");
    const save = {
        model: "crm.lead",
        method: "web_save",
        args: [[2], { phone: "+32 470 65 43 21" }],
        kwargs: { context: queuedContext(), specification: {} },
    };
    expect(queuedCalls("crm.lead")).toEqual([save]);

    // Reopened offline, the lead shows the queued number, and its Call opens it.
    await goBack();
    await contains(".o_data_row:contains(Lead 2) .o_data_cell").click();
    expect(phoneInput).toHaveValue("+32 470 65 43 21");
    expect(phoneFields.at(-1).phoneHref).toBe("tel:+32470654321");
    phoneFields.at(-1).onLinkClicked();
    expect.verifySteps(["open tel:+32470654321"]);
    expect(queuedCalls("crm.lead")).toEqual([save]);
    expect.verifyErrors([LEAD_LIST_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] lead create and edit queue and replay", async () => {
    // The framework's cached root loads (list back, form reopen, form reload after
    // the discard) raise their lost network fallback offline; the CRM code adds none.
    expect.errors(3);
    stepWebSave();
    const rejection = rejectReplay("crm.lead", "web_save", "Save refused");
    defineActions([
        {
            id: 2,
            xml_id: "crm.crm_lead_all_leads",
            name: "Leads",
            res_model: "crm.lead",
            views: [
                [false, "list"],
                [false, "form"],
            ],
        },
    ]);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(2);

    // Online: visit "Lead 2" and the new-lead form, so both are cached.
    await contains(".o_data_row:contains(Lead 2) .o_data_cell").click();
    await contains(".o_breadcrumb .o_back_button").click();
    await contains(".o_list_button_add").click();
    await flushStartupSync();

    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Offline Lead");
    await contains(".o_form_button_save").click();
    expect(".o_field_widget[name=name] input").toHaveValue("Offline Lead");

    await contains(".o_breadcrumb .o_back_button").click();
    await contains(".o_data_row:contains(Lead 2) .o_data_cell").click();
    await contains(".o_field_widget[name=name] input").edit("Lead 2 edited offline");
    await contains(".o_form_button_save").click();
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 2 edited offline");

    // One create and one edit, in the order they were made. The create carries the new
    // lead's delivery key.
    const kwargs = { context: queuedContext(), specification: {} };
    const createValues = queuedCalls("crm.lead")[0].args[1];
    expect(createValues).toMatchObject({ name: "Offline Lead", type: "opportunity" });
    const deliveryKey = queuedCalls("crm.lead")[0].kwargs.context[CRM_OFFLINE_CREATE_KEY];
    expect(deliveryKey).toMatch(/^[0-9a-f]{32}$/);
    const create = {
        model: "crm.lead",
        method: "web_save",
        args: [[], createValues],
        kwargs: { ...kwargs, context: { ...kwargs.context, [CRM_OFFLINE_CREATE_KEY]: deliveryKey } },
    };
    const edit = {
        model: "crm.lead",
        method: "web_save",
        args: [[2], { name: "Lead 2 edited offline" }],
        kwargs,
    };
    expect(queuedCalls("crm.lead")).toEqual([create, edit]);
    expect.verifySteps([]);

    await reconnect(setOffline);
    await advanceTime(1000);
    await expect.waitForSteps([create, edit]);
    expect(queued("crm.lead")).toEqual([]);
    const { env } = MockServer;
    expect(env["crm.lead"].search_count([["name", "=", "Offline Lead"]])).toBe(1);
    expect(env["crm.lead"].browse(2)[0].name).toBe("Lead 2 edited offline");

    // A discarded edit reverts the form and writes nothing.
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 2 discarded");
    await contains(".o_form_button_save").click();
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[2], { name: "Lead 2 discarded" }],
            kwargs,
        },
    ]);
    await discardFromSystray("Lead 2 discarded");
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 2 edited offline");

    // A rejected replay is parked; the server keeps its value.
    await contains(".o_field_widget[name=name] input").edit("Lead 2 parked");
    await contains(".o_form_button_save").click();
    rejection.reject = true;
    await reconnect(setOffline);
    expectParked("crm.lead", "Save refused");
    expect(env["crm.lead"].browse(2)[0].name).toBe("Lead 2 edited offline");
    expect.verifySteps([]);
    expect.verifyErrors([LEAD_LIST_LOAD, LEAD_RECORD_LOAD, LEAD_RECORD_LOAD]);
});

test.tags("desktop");
test("[Offline] lead form reopened offline after a replayed edit shows the server values on desktop", async () => {
    // The framework's cached root loads offline: the form, the pipeline back, and
    // the form reopened after the replay.
    expect.errors(3);
    const reads = [];
    onRpc("crm.lead", "web_read", (params) => {
        reads.push(callPayload(params));
    });
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    await openLead(2);
    await goBack();
    const formRead = reads.find(({ args }) => args[0][0] === 2);
    expect(formRead.kwargs.specification).not.toInclude("activity_ids");

    // Edited offline in its form, then left.
    await setOffline(true);
    await openLead(2);
    await contains(".o_field_widget[name=name] input").edit("Lead 2 edited offline");
    await contains(".o_form_button_save").click();
    await goBack();

    // The replay of the edit requests the form's cached read again, as the form did.
    reads.splice(0);
    await reconnect(setOffline);
    expect(queued("crm.lead")).toEqual([]);
    expect(reads).toEqual([formRead]);

    // Offline again, the form shows the replayed value.
    await setOffline(true);
    await openLead(2);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 2 edited offline");
    expect.verifyErrors([LEAD_RECORD_LOAD, LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] lead form create can be discarded or parked", async () => {
    const rejection = rejectReplay("crm.lead", "web_save", "Creation refused");
    // Registered after the rejection, so it runs first: every save reaching the mock
    // server is stepped, the rejected replay included.
    stepWebSave();
    const setOffline = mockOffline();
    await openPipeline();
    // Offline root loads served from the cache: the pipeline after each create, the
    // new-lead form opened offline, and (mobile pipeline) its reload after the first
    // discard. Declared once the web client runs: the preset is only known then.
    expect.errors(isSmall() ? 4 : 3);
    await flushStartupSync();
    const { env } = MockServer;
    // The pipeline's create button opens the lead form ("New" without quick create).
    const newButton = ".o_control_panel .o-kanban-button-new";

    /**
     * Saves the displayed new-lead form offline, named `name` in the "New" stage, and
     * returns its queued create: the action's context (with `default_type`) and the
     * new lead's delivery key, and no read-back specification.
     */
    async function createLeadOffline(name) {
        await contains(".o_field_widget[name=name] input").edit(name);
        await selectStage(STAGE_NEW, "New");
        await contains(".o_form_button_save").click();
        expect(".o_field_widget[name=name] input").toHaveValue(name);
        const [{ args, kwargs }] = queuedCalls("crm.lead");
        expect(args[1]).toMatchObject({ name, type: "opportunity", stage_id: STAGE_NEW });
        const deliveryKey = kwargs.context[CRM_OFFLINE_CREATE_KEY];
        expect(deliveryKey).toMatch(/^[0-9a-f]{32}$/);
        const create = {
            model: "crm.lead",
            method: "web_save",
            args: [[], args[1]],
            kwargs: {
                context: {
                    ...queuedContext(PIPELINE_ACTION.context),
                    [CRM_OFFLINE_CREATE_KEY]: deliveryKey,
                },
                specification: {},
            },
        };
        expect(queuedCalls("crm.lead")).toEqual([create]);
        expect(queued("crm.lead")[0].value.kwargs.context.default_type).toBe("opportunity");
        return create;
    }

    /**
     * Asserts the mobile pipeline's provisional card of `name` in "New", with its sync
     * badge, counted by the stage header with the stage's three leads.
     */
    async function expectProvisionalCard(name, badge, badgeClass) {
        const card = await revealLeadCard(name);
        expect(`${card}.o_crm_mobile_lead_card_provisional`).toHaveCount(1);
        expect(`${card} .o_crm_mobile_pending_sync`).toHaveText(badge);
        expect(`${card} .o_crm_mobile_pending_sync`).toHaveClass(badgeClass);
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("New");
        expect(".o_crm_mobile_pipeline_count").toHaveText("4");
    }

    // Online: the new-lead form is visited, so it is cached.
    await contains(newButton).click();
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("");

    await setOffline(true);
    await createLeadOffline("Discarded Lead");
    expect.verifySteps([]);
    await goBack();
    if (isSmall()) {
        await expectProvisionalCard("Discarded Lead", "Pending sync", "text-bg-warning");
    }
    await discardFromSystray("Discarded Lead");
    expect(queued("crm.lead")).toEqual([]);
    expect(pipelineLeadNames()).not.toInclude("Discarded Lead");
    if (isSmall()) {
        expect(".o_crm_mobile_pipeline_count").toHaveText("3");
    }
    await reconnect(setOffline);
    expect.verifySteps([]);
    expect(env["crm.lead"].search_count([["name", "=", "Discarded Lead"]])).toBe(0);

    // The second create opens the new-lead form offline: the online visit cached it.
    await setOffline(true);
    expect(newButton).toHaveAttribute("data-available-offline");
    expect(newButton).toBeEnabled();
    await contains(newButton).click();
    const create = await createLeadOffline("Parked Lead");
    expect.verifySteps([]);
    // Left before the replay: this case covers the queue and the pipeline, not the
    // form's own reload after a replay.
    await goBack();
    rejection.reject = true;
    await reconnect(setOffline);
    expect.verifySteps([create]);
    expectParked("crm.lead", "Creation refused");
    expect(queuedCalls("crm.lead")).toEqual([create]);
    expect(env["crm.lead"].search_count([["name", "=", "Parked Lead"]])).toBe(0);
    await openSystray();
    const errorRow = ".o_offline_systray_content .o-dropdown-item div.text-danger";
    expect(errorRow).toHaveText("Parked Lead");
    expect(queryFirst(errorRow).dataset.tooltip).toInclude("Creation refused");
    await press("Escape");
    await animationFrame();
    if (isSmall()) {
        await expectProvisionalCard("Parked Lead", "Sync failed", "text-bg-danger");
    }
    // The next replay skips it.
    await setOffline(true);
    await reconnect(setOffline);
    expect.verifySteps([]);

    await discardFromSystray("Parked Lead");
    expect(queued("crm.lead")).toEqual([]);
    expect(pipelineLeadNames()).not.toInclude("Parked Lead");
    if (isSmall()) {
        expect(".o_crm_mobile_pipeline_count").toHaveText("3");
    }
    await runAllTimers();
    expect.verifySteps([]);
    expect(env["crm.lead"].search_count([["name", "in", ["Discarded Lead", "Parked Lead"]]])).toBe(
        0
    );
    expect(".modal").toHaveCount(0);
    expect.verifyErrors([
        LEAD_GROUPS_LOAD, // pipeline after the discarded create
        ...(isSmall() ? [LEAD_GROUPS_LOAD] : []), // mobile pipeline reload after the discard
        "/web/dataset/call_kw/crm.lead/onchange", // new-lead form opened offline
        LEAD_GROUPS_LOAD, // pipeline after the parked create
    ]);
});

test("[Offline] lead created in a form kept open is created once on reconnect", async () => {
    // No root load runs offline: the new-lead form stays open until the reconnection,
    // and the list it returns to loads online. No error is declared.
    stepWebSave();
    const rejection = rejectReplay("crm.lead", "web_save", "Create refused");
    defineActions([
        {
            id: 2,
            xml_id: "crm.crm_lead_all_leads",
            name: "Leads",
            res_model: "crm.lead",
            views: [
                [false, "list"],
                [false, "form"],
            ],
        },
    ]);
    const setOffline = mockOffline();
    // Steps every lead onchange reaching the server: the new-lead form's load, which
    // a blank reset of the created lead after its replay would issue again.
    onRpc("crm.lead", "onchange", () => {
        expect.step("crm.lead onchange");
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(2);
    await flushStartupSync();
    const { env } = MockServer;

    /**
     * Opens the new-lead form online (its onchange is cached), then creates the lead
     * `name` offline and stays on its form.
     *
     * @param {string} name
     * @returns {Promise<{key: string, value: Object}>} the queued create
     */
    async function createOffline(name) {
        await contains(".o_list_button_add").click();
        expect.verifySteps(["crm.lead onchange"]);
        await setOffline(true);
        await contains(".o_field_widget[name=name] input").edit(name);
        await contains(".o_form_button_save").click();
        expect(".o_form_view .o_field_widget[name=name] input").toHaveValue(name);
        const entries = queued("crm.lead");
        const [{ args, kwargs }] = queuedCalls("crm.lead");
        expect(args[1]).toMatchObject({ name });
        const deliveryKey = kwargs.context[CRM_OFFLINE_CREATE_KEY];
        expect(deliveryKey).toMatch(/^[0-9a-f]{32}$/);
        expect(queuedCalls("crm.lead")).toEqual([
            {
                model: "crm.lead",
                method: "web_save",
                args: [[], args[1]],
                kwargs: {
                    context: { ...queuedContext(), [CRM_OFFLINE_CREATE_KEY]: deliveryKey },
                    specification: {},
                },
            },
        ]);
        expect.verifySteps([]);
        return entries[0];
    }

    /**
     * Waits for the list the form returned to, listing `name` from the server, then
     * lets every timer run: nothing else reaches the server (no onchange, no second
     * create).
     *
     * @param {string} name
     */
    async function expectLeftForList(name) {
        await waitFor(`.o_list_view .o_data_row:contains(${name})`);
        await runAllTimers();
        await animationFrame();
        expect(".o_form_view").toHaveCount(0);
        expect(`.o_list_view .o_data_row:contains(${name})`).toHaveCount(1);
        expect(queued("crm.lead")).toEqual([]);
        expect.verifySteps([]);
    }

    // The replay creates the lead once. It returns no id, so the form cannot show the
    // created lead: it is left for the list, never reset to a blank new lead.
    const create = await createOffline("Kept Open Lead");
    await reconnect(setOffline);
    await expect.waitForSteps([callPayload(create.value)]);
    await expectLeftForList("Kept Open Lead");
    expect(env["crm.lead"].search_count([["name", "=", "Kept Open Lead"]])).toBe(1);

    // Edits made after the offline save, which the user did not save, are dropped:
    // never saved as a second create when the form is left.
    const dirtyCreate = await createOffline("Saved Lead");
    await contains(".o_field_widget[name=name] input").edit("Unsaved edit");
    await reconnect(setOffline);
    await expect.waitForSteps([callPayload(dirtyCreate.value)]);
    await expectLeftForList("Saved Lead");
    expect(env["crm.lead"].search_count([["name", "=", "Saved Lead"]])).toBe(1);
    expect(env["crm.lead"].search_count([["name", "=", "Unsaved edit"]])).toBe(0);

    // A rejected create is parked: the form stays on the new lead with its values.
    await createOffline("Parked Lead");
    rejection.reject = true;
    await reconnect(setOffline);
    expectParked("crm.lead", "Create refused");
    expect(".o_list_view").toHaveCount(0);
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Parked Lead");
    expect(env["crm.lead"].search_count([["name", "=", "Parked Lead"]])).toBe(0);
    expect.verifySteps([]);
});

test("[Offline] form stage change queues through the statusbar", async () => {
    // Offline root load served from the cache: the form's reload after the discard.
    expect.errors(1);
    stepWebSave();
    const rejection = rejectReplay("crm.lead", "web_save", "Stage refused");
    const setOffline = mockOffline();
    // Through the web client (lead form `LEAD_FORM_ARCH`), for the offline systray.
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    await setOffline(true);
    // Every statusbar control is usable offline: it carries the attribute, so the
    // framework does not disable it (the current stage is disabled online as well).
    expect(".o_statusbar_status button:visible").toHaveCount(isSmall() ? 1 : 3);
    for (const button of queryAll(".o_statusbar_status button")) {
        expect(button).toHaveAttribute("data-available-offline", "1");
        expect(button).not.toHaveClass("o_disabled_offline");
    }
    for (const button of queryAll(
        ".o_statusbar_status button:visible:not(.o_arrow_button_current)"
    )) {
        expect(button).toBeEnabled();
    }
    if (isSmall()) {
        await contains(".o_statusbar_status button.dropdown-toggle").click();
        expect(".o-dropdown--menu .dropdown-item").toHaveCount(3);
        for (const item of queryAll(".o-dropdown--menu .dropdown-item")) {
            expect(item).toHaveAttribute("data-available-offline", "1");
            expect(item).not.toHaveClass("o_disabled_offline");
        }
        await contains(".o-dropdown--menu .dropdown-item:contains(Qualified)").click();
    } else {
        await contains(".o_statusbar_status button[data-value='2']").click();
    }
    expect(
        isSmall() ? ".o_statusbar_status .dropdown-toggle:visible" : ".o_arrow_button_current"
    ).toHaveText("Qualified");
    await contains(".o_form_button_save").click();

    const save = {
        model: "crm.lead",
        method: "web_save",
        args: [[1], { stage_id: STAGE_QUALIFIED }],
        kwargs: { context: queuedContext(PIPELINE_ACTION.context), specification: {} },
    };
    expect(queuedCalls("crm.lead")).toEqual([save]);
    expect.verifySteps([]);

    await reconnect(setOffline);
    await expect.waitForSteps([save]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_QUALIFIED);

    // A discarded stage change reverts the statusbar and writes nothing.
    const currentStage = isSmall()
        ? ".o_statusbar_status .dropdown-toggle:visible"
        : ".o_arrow_button_current";
    await setOffline(true);
    await selectStage(STAGE_NEW, "New");
    await contains(".o_form_button_save").click();
    expect(currentStage).toHaveText("New");
    await discardFromSystray("Lead 1");
    expect(queued("crm.lead")).toEqual([]);
    expect(currentStage).toHaveText("Qualified");

    // A rejected replay is parked; the server keeps its stage.
    await selectStage(STAGE_NEW, "New");
    await contains(".o_form_button_save").click();
    rejection.reject = true;
    await reconnect(setOffline);
    expectParked("crm.lead", "Stage refused");
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_QUALIFIED);
    expect.verifySteps([]);
    expect.verifyErrors([LEAD_RECORD_LOAD]);
});

test("[Online] lead form statusbar unchanged", async () => {
    stepWebSave();
    // Reference: the same field rendered by mail's widget, outside the CRM lead form.
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        arch: LEAD_FORM_ARCH.replace(` js_class="crm_form"`, ""),
    });
    const referenceHtml = queryFirst(".o_statusbar_status").outerHTML;
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        arch: LEAD_FORM_ARCH,
        config: { actionId: 1 },
    });
    const crmStatusbar = queryAll(".o_statusbar_status")[1];
    expect(crmStatusbar.outerHTML.replaceAll(` data-available-offline="1"`, "")).toBe(
        referenceHtml
    );
    expect(queryAll(".o_statusbar_status button", { root: crmStatusbar })).not.toHaveLength(0);
    for (const button of queryAll(".o_statusbar_status")[0].querySelectorAll("button")) {
        expect(button).not.toHaveAttribute("data-available-offline");
    }

    // The same selection saves online: an inline button on desktop, the all-stages
    // dropdown item on the mobile preset.
    if (isSmall()) {
        await click(queryFirst("button.dropdown-toggle:visible", { root: crmStatusbar }));
        await contains(".o-dropdown--menu .dropdown-item:contains(Qualified)").click();
    } else {
        await click(crmStatusbar.querySelector(`button[data-value='${STAGE_QUALIFIED}']`));
        await animationFrame();
    }
    await contains(".o_form_button_save").click();
    await expect.waitForSteps([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_QUALIFIED }],
            kwargs: { context: callContext(), specification: leadFormReadBack() },
        },
    ]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_QUALIFIED);
});

/** Pipeline on the limit-2 kanban view (a partially loaded "New" column). */
const LIMITED_PIPELINE_ACTION = {
    type: "ir.actions.act_window",
    name: "Pipeline",
    res_model: "crm.lead",
    views: [[LIMITED_KANBAN_VIEW_ID, "kanban"]],
    context: { default_type: "opportunity" },
};

test.tags("desktop");
test("[Offline] kanban stage move to an unfolded stage queues one web_save and replays", async () => {
    stepWebSave();
    const rejection = rejectReplay("crm.lead", "web_save", "Move refused");
    const setOffline = mockOffline();
    const stepping = stepRoutes((route) => route.includes("/crm.lead/"));
    // Through the web client, for the offline systray.
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LIMITED_PIPELINE_ACTION);
    await flushStartupSync();
    expect.verifySteps([
        "/web/dataset/call_kw/crm.lead/get_views",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);
    // "New" holds three leads and loaded two of them.
    expect(".o_kanban_group:eq(0) .o_kanban_record").toHaveCount(2);
    expect(".o_kanban_group:eq(0) .o_kanban_load_more").toHaveCount(1);

    await setOffline(true);
    await contains(".o_kanban_group:eq(0) .o_kanban_record:contains(Lead 1)").dragAndDrop(
        ".o_kanban_group:eq(1)"
    );

    // The card moved at once; one queued write, no resequence, no column reload.
    expect(".o_kanban_group:eq(0) .o_kanban_record:contains(Lead 1)").toHaveCount(0);
    expect(".o_kanban_group:eq(1) .o_kanban_record:contains(Lead 1)").toHaveCount(1);
    const move = {
        model: "crm.lead",
        method: "web_save",
        args: [[1], { stage_id: STAGE_QUALIFIED }],
        kwargs: {
            context: queuedContext(LIMITED_PIPELINE_ACTION.context, {
                default_stage_id: STAGE_NEW,
            }),
            specification: {},
        },
    };
    expect(queuedCalls("crm.lead")).toEqual([move]);
    expect.verifySteps(["/web/dataset/call_kw/crm.lead/web_save"]);

    await reconnect(setOffline);
    await expect.waitForSteps(["/web/dataset/call_kw/crm.lead/web_save", move]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_QUALIFIED);
    stepping.active = false;

    // A discarded move brings the card back to its column after the reload.
    const lead2 = ".o_kanban_record:contains(Lead 2)";
    await setOffline(true);
    await contains(`.o_kanban_group:eq(0) ${lead2}`).dragAndDrop(".o_kanban_group:eq(1)");
    expect(`.o_kanban_group:eq(1) ${lead2}`).toHaveCount(1);
    await discardFromSystray("Lead 2");
    expect(queued("crm.lead")).toEqual([]);
    await reconnect(setOffline);
    await getService("action").doAction(LIMITED_PIPELINE_ACTION, { clearBreadcrumbs: true });
    expect(`.o_kanban_group:eq(0) ${lead2}`).toHaveCount(1);
    expect(MockServer.env["crm.lead"].browse(2)[0].stage_id).toBe(STAGE_NEW);

    // A rejected replay is parked; the server keeps the stage.
    await setOffline(true);
    await contains(`.o_kanban_group:eq(0) ${lead2}`).dragAndDrop(".o_kanban_group:eq(1)");
    rejection.reject = true;
    await reconnect(setOffline);
    expectParked("crm.lead", "Move refused");
    expect(MockServer.env["crm.lead"].browse(2)[0].stage_id).toBe(STAGE_NEW);
    expect.verifySteps([]);
});

test.tags("desktop");
test("[Online] kanban stage move reloads the source column", async () => {
    stepWebSave();
    stepRoutes((route) => route.includes("/crm.lead/"));
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        arch: pipelineArch({ limit: 2 }),
        groupBy: ["stage_id"],
        config: { actionId: 1 },
    });
    expect.verifySteps([
        "/web/dataset/call_kw/crm.lead/get_views",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);

    await contains(".o_kanban_group:eq(0) .o_kanban_record:contains(Lead 1)").dragAndDrop(
        ".o_kanban_group:eq(1)"
    );

    // The partially loaded source column is reloaded, so its third lead shows up.
    expect.verifySteps([
        "/web/dataset/call_kw/crm.lead/web_save",
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_QUALIFIED }],
            kwargs: {
                context: callContext({}, { default_stage_id: STAGE_NEW }),
                specification: {
                    active: {},
                    color: {},
                    expected_revenue: {},
                    is_rotting: {},
                    name: {},
                    stage_id: { fields: { display_name: {} } },
                    won_status: {},
                },
            },
        },
        "/web/dataset/call_kw/crm.lead/web_search_read",
        "/web/dataset/call_kw/crm.lead/get_rainbowman_message",
    ]);
    expect(".o_kanban_group:eq(0) .o_kanban_record").toHaveCount(2);
    expect(".o_kanban_group:eq(0) .o_kanban_record:contains(Lead 3)").toHaveCount(1);
});

/** Pipeline whose cards hold their `kanban_activity` button (a `<button>`). */
const ACTIVITY_PIPELINE_ACTION = {
    type: "ir.actions.act_window",
    name: "Pipeline",
    res_model: "crm.lead",
    views: [[ACTIVITY_KANBAN_VIEW_ID, "kanban"]],
    context: { default_type: "opportunity" },
};

test.tags("desktop");
test("[Offline] kanban drag of a lead not opened online moves it and queues one web_save", async () => {
    stepWebSave();
    const setOffline = mockOffline();
    stepRoutes((route) => route.includes("/crm.lead/"));
    // Through the web client, for the offline systray.
    await mountWithCleanup(WebClient);
    await getService("action").doAction(ACTIVITY_PIPELINE_ACTION);
    await flushStartupSync();
    expect.verifySteps([
        "/web/dataset/call_kw/crm.lead/get_views",
        "/web/dataset/call_kw/crm.lead/web_read_group",
    ]);

    // Lead 1's form was never opened: offline, the framework disables its card and
    // its activity button (`.o_disabled_offline`, with `pointer-events: auto !important`).
    await setOffline(true);
    const lead1 = ".o_kanban_record:contains(Lead 1)";
    expect(`.o_kanban_group:eq(0) ${lead1}`).toHaveClass("o_disabled_offline");

    const { drop, moveTo } = await contains(`.o_kanban_group:eq(0) ${lead1}`).drag();
    await moveTo(".o_kanban_group:eq(1)");

    // While dragged, neither the card nor its disabled controls take the pointer, so
    // a real pointer reaches the columns under the card instead of the card itself.
    const dragged = ".o_kanban_record.o_dragged";
    expect(`${dragged}:contains(Lead 1)`).toHaveCount(1);
    expect(dragged).toHaveClass("o_disabled_offline");
    expect(dragged).toHaveStyle({ "pointer-events": "none" });
    expect(`${dragged} .o_disabled_offline`).not.toHaveCount(0);
    expect(`${dragged} .o_disabled_offline`).toHaveStyle({ "pointer-events": "none" });
    const draggedEl = queryFirst(dragged);
    const { x, y, width, height } = draggedEl.getBoundingClientRect();
    const hitEl = document.elementFromPoint(x + width / 2, y + height / 2);
    expect(draggedEl.contains(hitEl)).toBe(false, {
        message: "the dragged card is not the element under its own centre",
    });

    await drop();

    // The card moved at once with one queued write; the release opened no form, so
    // nothing else was requested.
    expect(`.o_kanban_group:eq(0) ${lead1}`).toHaveCount(0);
    expect(`.o_kanban_group:eq(1) ${lead1}`).toHaveCount(1);
    expect(dragged).toHaveCount(0);
    expect(".o_form_view").toHaveCount(0);
    const move = {
        model: "crm.lead",
        method: "web_save",
        args: [[1], { stage_id: STAGE_QUALIFIED }],
        kwargs: {
            context: queuedContext(ACTIVITY_PIPELINE_ACTION.context, {
                default_stage_id: STAGE_NEW,
            }),
            specification: {},
        },
    };
    expect(queuedCalls("crm.lead")).toEqual([move]);
    expect.verifySteps(["/web/dataset/call_kw/crm.lead/web_save"]);

    await reconnect(setOffline);
    await expect.waitForSteps(["/web/dataset/call_kw/crm.lead/web_save", move]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_QUALIFIED);
    expect.verifySteps([]);
});

/** "My Pipeline" (`crm.crm_lead_action_pipeline`): the lead kanban and form. */
const PIPELINE_ACTION = {
    id: 1,
    xml_id: "crm.crm_lead_action_pipeline",
    name: "Pipeline",
    res_model: "crm.lead",
    views: [
        [false, "kanban"],
        [false, "form"],
    ],
    // The real action's context also shows the lead generation dropdown.
    context: { default_type: "opportunity", show_lead_gen_button: true },
};

/** Sales Teams dashboard (`sales_team.crm_team_action_pipeline`). */
const TEAM_ACTION = {
    id: 4,
    xml_id: "sales_team.crm_team_action_pipeline",
    name: "Teams",
    res_model: "crm.team",
    views: [
        [false, "kanban"],
        [false, "form"],
    ],
};

/** Configuration > Stages (`crm.crm_stage_action`). */
const STAGE_ACTION = {
    id: 5,
    xml_id: "crm.crm_stage_action",
    name: "Stages",
    res_model: "crm.stage",
    views: [
        [false, "list"],
        [false, "form"],
    ],
};

/**
 * Team pipeline opened from a dashboard card (`crm.crm_case_form_view_salesteams_opportunity`):
 * its context selects the card's team as a search facet, as the real action does.
 */
const TEAM_PIPELINE_ACTION = {
    id: TEAM_PIPELINE_ACTION_ID,
    xml_id: "crm.crm_case_form_view_salesteams_opportunity",
    name: "Team Pipeline",
    res_model: "crm.lead",
    views: [
        [false, "kanban"],
        [false, "form"],
    ],
    context: "{'search_default_team_id': [active_id], 'default_team_id': active_id, 'default_type': 'opportunity'}",
};

/** Team pipeline analysis (`crm.action_report_crm_opportunity_salesteam`). */
const TEAM_REPORT_ACTION = {
    id: TEAM_REPORT_ACTION_ID,
    xml_id: "crm.action_report_crm_opportunity_salesteam",
    name: "Pipeline Analysis",
    res_model: "crm.lead",
    views: [[false, "pivot"]],
};

/** A team's leads, from a dashboard card (`crm.crm_case_form_view_salesteams_lead`). */
const TEAM_LEADS_ACTION = {
    id: TEAM_LEADS_ACTION_ID,
    xml_id: "crm.crm_case_form_view_salesteams_lead",
    name: "Leads",
    res_model: "crm.lead",
    views: [
        [false, "list"],
        [false, "form"],
    ],
    context: "{'search_default_team_id': [active_id], 'default_team_id': active_id, 'default_type': 'lead'}",
};

/** New lead, from a dashboard card (`crm.crm_lead_action_open_lead_form`). */
const NEW_LEAD_ACTION = {
    id: NEW_LEAD_ACTION_ID,
    xml_id: "crm.crm_lead_action_open_lead_form",
    name: "New Lead",
    res_model: "crm.lead",
    views: [[false, "form"]],
    context: "{'default_team_id': active_id, 'default_type': 'lead'}",
};

/** New opportunity, from a dashboard card (`crm.action_opportunity_form`). */
const NEW_OPPORTUNITY_ACTION = {
    id: NEW_OPPORTUNITY_ACTION_ID,
    xml_id: "crm.action_opportunity_form",
    name: "New Opportunity",
    res_model: "crm.lead",
    views: [[false, "form"]],
    context: "{'default_team_id': active_id, 'default_type': 'opportunity'}",
};

defineActions([
    PIPELINE_ACTION,
    TEAM_ACTION,
    STAGE_ACTION,
    TEAM_PIPELINE_ACTION,
    TEAM_REPORT_ACTION,
    TEAM_LEADS_ACTION,
    NEW_LEAD_ACTION,
    NEW_OPPORTUNITY_ACTION,
]);

/** Mounts the web client on "My Pipeline". */
async function openPipeline() {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(PIPELINE_ACTION.id);
}

/** Opens a lead form from the current action (kept in the breadcrumbs). */
async function openLead(resId) {
    await getService("action").switchView("form", { resId });
    await animationFrame();
}

/** Goes back to the previous controller (breadcrumb back button). */
async function goBack() {
    await contains(".o_breadcrumb .o_back_button").click();
}

/**
 * Discards the queued entries of a record from the offline systray (trash button,
 * then the confirmation).
 *
 * @param {string} displayName
 */
async function discardFromSystray(displayName) {
    await openSystray();
    await contains(
        `.o_offline_systray_content .o-dropdown-item:contains(${displayName}) button[title="Discard offline changes"]`
    ).click();
    await contains(".modal-footer .btn-primary").click();
}

/**
 * Makes the mock server reject the replay of `method` on `model` while `state.reject`
 * is true, with a server error whose message is `message`.
 */
function rejectReplay(model, method, message) {
    const state = { reject: false };
    onRpc(model, method, () => {
        if (state.reject) {
            throw makeServerError({ message });
        }
    });
    return state;
}

/**
 * Asserts a parked replay: the queue keeps the model's only entry with the server's
 * error, and the offline systray shows its error icon.
 *
 * @param {string} model
 * @param {string} message the rejection message given to `rejectReplay`
 */
function expectParked(model, message) {
    const entries = queued(model);
    expect(entries.length).toBe(1);
    expect(entries[0].value.extras.error).toBe(`odoo.exceptions.UserError - ${message}`);
    expect(".o_menu_systray .o_offline_systray .fa-exclamation-circle").toHaveCount(1);
}

test.tags("desktop");
test("[Offline] card menu delete removes the card and queues unlink", async () => {
    stepCalls("crm.lead", "unlink");
    const rejection = rejectReplay("crm.lead", "unlink", "Deletion refused");
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    expect(queryAllTexts(".o_kanban_group .o_column_title")).toEqual([
        "New\n(3)",
        "Qualified\n(1)",
        "Won\n(1)",
    ]);

    /** Deletes a card through its menu, opened offline. */
    async function deleteCard(name) {
        const toggle = `.o_kanban_record:contains(${name}) .o_dropdown_kanban .dropdown-toggle`;
        expect(toggle).toHaveAttribute("data-available-offline", "1");
        expect(toggle).toBeEnabled();
        await contains(toggle, { visible: false }).click();
        await contains(".o-dropdown--menu .dropdown-item:contains(Delete)").click();
        await contains(".modal-footer .btn-danger").click();
    }

    // Replayed delete.
    await setOffline(true);
    await deleteCard("Lead 1");
    expect(".o_kanban_record:contains(Lead 1)").toHaveCount(0);
    expect(".o_kanban_group:eq(0) .o_column_title").toHaveText("New\n(2)");
    // The card menu deletes through the pipeline's root list: its context has no
    // column default.
    const unlink = {
        model: "crm.lead",
        method: "unlink",
        args: [[1]],
        kwargs: { context: queuedContext(PIPELINE_ACTION.context) },
    };
    expect(queuedCalls("crm.lead")).toEqual([unlink]);
    expect.verifySteps([]);
    await reconnect(setOffline);
    await expect.waitForSteps([unlink]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].search_count([["id", "=", 1]])).toBe(0);

    // Discarded delete: the card is back after the reload.
    await setOffline(true);
    await deleteCard("Lead 2");
    expect(".o_kanban_record:contains(Lead 2)").toHaveCount(0);
    await discardFromSystray("Lead 2");
    expect(queued("crm.lead")).toEqual([]);
    await reconnect(setOffline);
    await getService("action").doAction(PIPELINE_ACTION.id, { clearBreadcrumbs: true });
    expect(".o_kanban_record:contains(Lead 2)").toHaveCount(1);
    expect.verifySteps([]);

    // Parked delete: rejected on replay, the entry stays in the systray and the card
    // is back after the reload.
    await setOffline(true);
    await deleteCard("Lead 3");
    expect(".o_kanban_record:contains(Lead 3)").toHaveCount(0);
    rejection.reject = true;
    await reconnect(setOffline);
    expect.verifySteps([]);
    const [parked] = queued("crm.lead");
    expect(parked.value).toMatchObject({
        method: "unlink",
        args: [[3]],
        extras: { error: "odoo.exceptions.UserError - Deletion refused" },
    });
    expect(parked.value.kwargs).toEqual(unlink.kwargs);
    await getService("action").doAction(PIPELINE_ACTION.id, { clearBreadcrumbs: true });
    expect(".o_kanban_record:contains(Lead 3)").toHaveCount(1);
    expect(".o_menu_systray .o_offline_systray .fa-exclamation-circle").toHaveCount(1);
    expect(".modal").toHaveCount(0);
});

test.tags("desktop");
test("[Offline] card menu colour changes the card and replays", async () => {
    stepWebSave();
    const rejection = rejectReplay("crm.lead", "web_save", "Colour refused");
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    expect(".o_kanban_record:contains(Lead 1)").toHaveClass("o_kanban_color_0");

    await setOffline(true);
    const toggle = ".o_kanban_record:contains(Lead 1) .o_dropdown_kanban .dropdown-toggle";
    expect(toggle).toHaveAttribute("data-available-offline", "1");
    await contains(toggle, { visible: false }).click();
    expect(".o-dropdown--menu .o_kanban_colorpicker button").toHaveCount(12);
    for (const button of queryAll(".o-dropdown--menu .o_kanban_colorpicker button")) {
        expect(button).toHaveAttribute("data-available-offline", "1");
        expect(button).toBeEnabled();
    }
    await contains(".o-dropdown--menu .o_colorlist_item_color_3").click();

    expect(".o_kanban_record:contains(Lead 1)").toHaveClass("o_kanban_color_3");
    const save = {
        model: "crm.lead",
        method: "web_save",
        args: [[1], { color: 3 }],
        kwargs: {
            context: queuedContext(PIPELINE_ACTION.context, { default_stage_id: STAGE_NEW }),
            specification: {},
        },
    };
    expect(queuedCalls("crm.lead")).toEqual([save]);
    expect.verifySteps([]);

    await reconnect(setOffline);
    await expect.waitForSteps([save]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].color).toBe(3);

    // A discarded colour change: the card has its server colour after the reload.
    const card = ".o_kanban_record:contains(Lead 1)";
    await setOffline(true);
    await contains(toggle, { visible: false }).click();
    await contains(".o-dropdown--menu .o_colorlist_item_color_4").click();
    expect(card).toHaveClass("o_kanban_color_4");
    await discardFromSystray("Lead 1");
    expect(queued("crm.lead")).toEqual([]);
    await reconnect(setOffline);
    await getService("action").doAction(PIPELINE_ACTION.id, { clearBreadcrumbs: true });
    expect(card).toHaveClass("o_kanban_color_3");

    // A rejected replay is parked; the server keeps the colour.
    await setOffline(true);
    await contains(toggle, { visible: false }).click();
    await contains(".o-dropdown--menu .o_colorlist_item_color_6").click();
    expect(card).toHaveClass("o_kanban_color_6");
    rejection.reject = true;
    await reconnect(setOffline);
    expectParked("crm.lead", "Colour refused");
    expect(MockServer.env["crm.lead"].browse(1)[0].color).toBe(3);
    expect.verifySteps([]);
});

test.tags("desktop");
test("[Offline] card menu Edit of a lead whose form was not opened online is absent and inert", async () => {
    // The framework's cached root loads offline: Lead 1's form and the pipeline back.
    expect.errors(2);
    const cards = {};
    patchWithCleanup(KanbanRecord.prototype, {
        setup() {
            super.setup(...arguments);
            if (this.props.record.resModel === "crm.lead") {
                cards[this.props.record.resId] = this;
            }
        },
    });
    const setOffline = mockOffline();
    const leadRoutes = stepRoutes((route) => route.includes("/crm.lead/"));
    leadRoutes.active = false;
    await openPipeline();
    await flushStartupSync();
    // Lead 1's form is opened online, Lead 2's is not.
    await openLead(1);
    await goBack();
    const menuToggle = (name) =>
        `.o_kanban_record:contains(${name}) .o_dropdown_kanban .dropdown-toggle`;
    const edit = ".o-dropdown--menu .dropdown-item:contains(Edit)";
    const columnTitles = queryAllTexts(".o_kanban_group .o_column_title");

    // Lead 2's menu, opened online, offers Edit.
    await contains(menuToggle("Lead 2"), { visible: false }).click();
    expect(edit).toHaveCount(1);

    // Offline, that open menu loses Edit (its card is dimmed by the framework), and
    // keeps Delete and the colours; the card's open and edit triggers, which Edit
    // calls, open nothing and request nothing.
    leadRoutes.active = true;
    await setOffline(true);
    await animationFrame();
    expect(".o_kanban_record:contains(Lead 2)").toHaveClass("o_disabled_offline");
    expect(edit).toHaveCount(0);
    expect(".o-dropdown--menu .dropdown-item:contains(Delete)").toHaveCount(1);
    expect(".o-dropdown--menu .o_kanban_colorpicker").toHaveCount(1);
    await cards[2].triggerAction({ type: "open" });
    await cards[2].triggerAction({ type: "edit" });
    await settle();
    expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    expect(".o_form_view").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);
    expect(queryAllTexts(".o_kanban_group .o_column_title")).toEqual(columnTitles);
    expect.verifySteps([]);

    // Lead 1, whose form was opened online, keeps Edit, which opens its cached form.
    expect(".o_kanban_record:contains(Lead 1)").not.toHaveClass("o_disabled_offline");
    await contains(menuToggle("Lead 1"), { visible: false }).click();
    expect(edit).toHaveCount(1);
    await contains(edit).click();
    await expectCurrentView("crm.crm_lead_action_pipeline/form");
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Lead 1");
    expect.verifySteps([LEAD_RECORD_LOAD]);
    await goBack();
    expect.verifySteps([LEAD_GROUPS_LOAD]);

    // Online again, Lead 2's menu offers Edit, which opens its form.
    await setOffline(false);
    await animationFrame();
    await contains(menuToggle("Lead 2"), { visible: false }).click();
    expect(edit).toHaveCount(1);
    await contains(edit).click();
    await expectCurrentView("crm.crm_lead_action_pipeline/form");
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Lead 2");
    expect.verifySteps([LEAD_RECORD_LOAD]);
    expect.verifyErrors([LEAD_RECORD_LOAD, LEAD_GROUPS_LOAD]);
});

/** Selectors of the "Europe" dashboard card. */
const EUROPE_CARD = ".o_kanban_record:contains(Europe)";
const EUROPE_MENU_TOGGLE = `${EUROPE_CARD} .o_dropdown_kanban .dropdown-toggle`;

test("[Offline] team card colour from a menu opened online queues and replays", async () => {
    stepWebSave("crm.team");
    const rejection = rejectReplay("crm.team", "web_save", "Colour refused");
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(TEAM_ACTION.id);
    await flushStartupSync();
    expect(".o_kanban_record:contains(Europe)").toHaveClass("o_kanban_color_1");

    // The manager opens the card menu online, then the connection drops.
    await contains(".o_kanban_record:contains(Europe) .o_dropdown_kanban .dropdown-toggle", {
        visible: false,
    }).click();
    await setOffline(true);
    expect(".o-dropdown--menu .o_kanban_colorpicker").toHaveCount(1);

    // "Configuration" (manage teams) stays disabled beside the usable colour picker
    // (its click, Enter and direct call are covered by the configuration-link test).
    const configuration = ".o-dropdown--menu a.dropdown-item:contains(Configuration)";
    expect(configuration).toHaveClass(["o_disabled_offline", "pe-none"]);
    expect(configuration).toHaveAttribute("aria-disabled", "true");
    expect(configuration).toHaveAttribute("tabindex", "-1");

    for (const button of queryAll(".o-dropdown--menu .o_kanban_colorpicker button")) {
        expect(button).toHaveAttribute("data-available-offline", "1");
        expect(button).toBeEnabled();
    }
    await contains(".o-dropdown--menu .o_colorlist_item_color_5").click();

    expect(".o_kanban_record:contains(Europe)").toHaveClass("o_kanban_color_5");
    const save = {
        model: "crm.team",
        method: "web_save",
        args: [[1], { color: 5 }],
        kwargs: { context: queuedContext(), specification: {} },
    };
    expect(queuedCalls("crm.team")).toEqual([save]);
    expect.verifySteps([]);

    await reconnect(setOffline);
    await expect.waitForSteps([save]);
    expect(queued("crm.team")).toEqual([]);
    expect(MockServer.env["crm.team"].browse(1)[0].color).toBe(5);

    /** Opens the "Europe" card menu online, disconnects and picks a colour. */
    const pickOfflineColour = async (colour) => {
        await contains(EUROPE_MENU_TOGGLE, { visible: false }).click();
        await setOffline(true);
        await contains(`.o-dropdown--menu .o_colorlist_item_color_${colour}`).click();
        expect(EUROPE_CARD).toHaveClass(`o_kanban_color_${colour}`);
    };
    // A discarded colour change: the card has its server colour after the reload.
    await pickOfflineColour(7);
    await discardFromSystray("Europe");
    expect(queued("crm.team")).toEqual([]);
    await reconnect(setOffline);
    await getService("action").doAction(TEAM_ACTION.id, { clearBreadcrumbs: true });
    expect(EUROPE_CARD).toHaveClass("o_kanban_color_5");

    // A rejected replay is parked; the server keeps the colour.
    await pickOfflineColour(8);
    rejection.reject = true;
    await reconnect(setOffline);
    expectParked("crm.team", "Colour refused");
    expect(MockServer.env["crm.team"].browse(1)[0].color).toBe(5);
    expect.verifySteps([]);
});

test("[Offline] stage form edit queues and replays", async () => {
    stepWebSave("crm.stage");
    const rejection = rejectReplay("crm.stage", "web_save", "Stage refused");
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(STAGE_ACTION.id);
    await contains(".o_data_row:contains(Qualified) .o_data_cell").click();
    await flushStartupSync();

    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Qualified (offline)");
    await contains(".o_form_button_save").click();

    expect(".o_field_widget[name=name] input").toHaveValue("Qualified (offline)");
    const save = {
        model: "crm.stage",
        method: "web_save",
        args: [[STAGE_QUALIFIED], { name: "Qualified (offline)" }],
        kwargs: { context: queuedContext(), specification: {} },
    };
    expect(queuedCalls("crm.stage")).toEqual([save]);
    expect.verifySteps([]);

    await reconnect(setOffline);
    await expect.waitForSteps([save]);
    expect(queued("crm.stage")).toEqual([]);
    expect(MockServer.env["crm.stage"].browse(STAGE_QUALIFIED)[0].name).toBe(
        "Qualified (offline)"
    );

    // A discarded edit writes nothing: the reopened stage has its server name.
    const nameInput = ".o_field_widget[name=name] input";
    await setOffline(true);
    await contains(nameInput).edit("Qualified (discarded)");
    await contains(".o_form_button_save").click();
    await discardFromSystray("Qualified (discarded)");
    expect(queued("crm.stage")).toEqual([]);
    await reconnect(setOffline);
    await getService("action").doAction(STAGE_ACTION.id, { clearBreadcrumbs: true });
    await contains(".o_data_row:contains(Qualified) .o_data_cell").click();
    expect(nameInput).toHaveValue("Qualified (offline)");

    // A rejected replay is parked; the server keeps its value.
    await setOffline(true);
    await contains(nameInput).edit("Qualified (parked)");
    await contains(".o_form_button_save").click();
    rejection.reject = true;
    await reconnect(setOffline);
    expectParked("crm.stage", "Stage refused");
    expect(MockServer.env["crm.stage"].browse(STAGE_QUALIFIED)[0].name).toBe(
        "Qualified (offline)"
    );
    expect.verifySteps([]);
});

/** Archives the displayed lead through the form's Action menu. */
async function archiveFromActionMenu() {
    await toggleActionMenu();
    await toggleMenuItem("Archive");
    await contains(".modal-footer .btn-primary").click();
}

/** Labels of the form's Action menu items (the menu is closed again). */
async function getActionMenuLabels() {
    await toggleActionMenu();
    const labels = queryAllTexts(".o-dropdown--menu .o_menu_item");
    await toggleActionMenu();
    return labels;
}

test("[Offline] form archive shows archived at once", async () => {
    // Offline root loads served from the cache: back to the pipeline, the reopened
    // lead, and the form's reload after the discard.
    expect.errors(3);
    const rejection = rejectReplay("crm.lead", "action_archive", "Archive refused");
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();
    expect(".ribbon:contains(Archived)").toHaveCount(0);

    // Archive offline: the ribbon and the Unarchive item show at once.
    await setOffline(true);
    await archiveFromActionMenu();
    expect(".ribbon:contains(Archived)").toHaveCount(1);
    expect(await getActionMenuLabels()).toInclude("Unarchive");
    const archive = {
        model: "crm.lead",
        method: "action_archive",
        args: [[1]],
        kwargs: { context: queuedContext(PIPELINE_ACTION.context) },
    };
    expect(queuedCalls("crm.lead")).toEqual([archive]);
    await goBack();
    await openLead(1);
    expect(".ribbon:contains(Archived)").toHaveCount(1);

    await discardFromSystray("Lead 1");
    expect(queued("crm.lead")).toEqual([]);
    expect(".ribbon:contains(Archived)").toHaveCount(0);
    expect(await getActionMenuLabels()).toInclude("Archive");

    // The replay archives the server record.
    await archiveFromActionMenu();
    expect(".ribbon:contains(Archived)").toHaveCount(1);
    expect(queuedCalls("crm.lead")).toEqual([archive]);
    expect.verifySteps([]);
    await reconnect(setOffline);
    await expect.waitForSteps([archive]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].search_count([["id", "=", 1], ["active", "=", false]])).toBe(
        1
    );
    expect(".ribbon:contains(Archived)").toHaveCount(1);

    // A parked (rejected) archive keeps the ribbon; the systray shows the error.
    await openLead(2);
    await setOffline(true);
    await archiveFromActionMenu();
    rejection.reject = true;
    await reconnect(setOffline);
    expect.verifySteps([]);
    expect(queued("crm.lead")[0].value.extras.error).toBe(
        "odoo.exceptions.UserError - Archive refused"
    );
    expect(".ribbon:contains(Archived)").toHaveCount(1);
    expect(".o_menu_systray .o_offline_systray .fa-exclamation-circle").toHaveCount(1);
    expect(MockServer.env["crm.lead"].browse(2)[0].active).toBe(true);
    expect.verifyErrors([LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] parked archive and won survive a reopen whose server read changed", async () => {
    // Every replay of the archive and of the won call is refused.
    const archiveRejection = rejectReplay("crm.lead", "action_archive", "Archive refused");
    archiveRejection.reject = true;
    const wonRejection = rejectReplay("crm.lead", "action_set_won", "Won refused");
    wonRejection.reject = true;
    const setOffline = mockOffline();
    // Holds the server's read of a reopened lead, which the form first shows from
    // the cache.
    let heldRead = null;
    onRpc("crm.lead", "web_read", () => heldRead?.promise);
    const wonButton = ".o_form_statusbar button[name=action_set_won_rainbowman]";
    const expectBothParked = () => {
        expect(
            queued("crm.lead").map(({ value }) => [value.method, value.args, value.extras.error])
        ).toEqual([
            ["action_archive", [[1]], "odoo.exceptions.UserError - Archive refused"],
            ["action_set_won", [[2]], "odoo.exceptions.UserError - Won refused"],
        ]);
        expect(".o_menu_systray .o_offline_systray .fa-exclamation-circle").toHaveCount(1);
    };
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    // Lead 1 archived and lead 2 won offline; both replays are parked.
    await setOffline(true);
    await archiveFromActionMenu();
    expect(".ribbon:contains(Archived)").toHaveCount(1);
    await reconnect(setOffline);
    await openLead(2);
    await setOffline(true);
    await contains(wonButton).click();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    await reconnect(setOffline);
    expectBothParked();

    // The server records change: each reopened lead shows its cached read with the
    // parked state, then the server's differing read, which keeps that state.
    MockServer.env["crm.lead"].write([1], { name: "Lead 1 (server)" });
    MockServer.env["crm.lead"].write([2], { name: "Lead 2 (server)" });
    await goBack();
    heldRead = Promise.withResolvers();
    let releaseRead = heldRead.resolve;
    await openLead(2);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 2");
    expect(".ribbon:contains(Won)").toHaveCount(1);
    heldRead = null;
    releaseRead();
    await animationFrame();
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 2 (server)");
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(".o_field_widget[name=probability]").toHaveText("100.00");
    expect(wonButton).toHaveCount(0);

    await goBack();
    heldRead = Promise.withResolvers();
    releaseRead = heldRead.resolve;
    await openLead(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1");
    expect(".ribbon:contains(Archived)").toHaveCount(1);
    heldRead = null;
    releaseRead();
    await animationFrame();
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 (server)");
    expect(".ribbon:contains(Archived)").toHaveCount(1);
    expect(await getActionMenuLabels()).toInclude("Unarchive");

    // Nothing was replayed or saved: both entries stay parked.
    expectBothParked();
    expect(MockServer.env["crm.lead"].browse(1)[0].active).toBe(true);
    expect(MockServer.env["crm.lead"].browse(2)[0].won_status).toBe("pending");
});

test("[Offline] form delete leaves the form at once", async () => {
    stepCalls("crm.lead", "unlink");
    const rejection = rejectReplay("crm.lead", "unlink", "Deletion refused");
    const setOffline = mockOffline();
    await openPipeline();
    // Offline root loads served from the cache: the pipeline after each delete and
    // each "leave again", the reopened leads, and (mobile pipeline) its reload after
    // each discard and its return after the parked delete. Declared once the web
    // client runs: the preset is only known then.
    expect.errors(isSmall() ? 10 : 7);
    await openLead(1);
    await flushStartupSync();

    /** Deletes the displayed lead through the form's Action menu. */
    async function deleteFromActionMenu() {
        await toggleActionMenu();
        await toggleMenuItem("Delete");
        await contains(".modal-footer .btn-danger").click();
    }

    await setOffline(true);
    await deleteFromActionMenu();
    expect(".o_form_view").toHaveCount(0);
    expect(".o_kanban_view").toHaveCount(1);
    // The mobile pipeline projects the queue onto its cards and hides the lead while
    // its delete is pending. Wide screens render the framework kanban unchanged (no
    // projection), where the cached card stays listed until the replay.
    if (isSmall()) {
        expect(pipelineLeadNames()).not.toInclude("Lead 1");
    }
    const unlink = {
        model: "crm.lead",
        method: "unlink",
        args: [[1]],
        kwargs: { context: queuedContext(PIPELINE_ACTION.context) },
    };
    expect(queuedCalls("crm.lead")).toEqual([unlink]);
    await openLead(1);
    expect(".o_form_view").toHaveCount(0);
    expect(".o_kanban_view").toHaveCount(1);
    expect.verifySteps([]);

    await reconnect(setOffline);
    await expect.waitForSteps([unlink]);
    expect(MockServer.env["crm.lead"].search_count([["id", "=", 1]])).toBe(0);

    // A discarded delete makes the lead reachable again.
    await openLead(2);
    await setOffline(true);
    await deleteFromActionMenu();
    expect(".o_form_view").toHaveCount(0);
    await discardFromSystray("Lead 2");
    expect(queued("crm.lead")).toEqual([]);
    await openLead(2);
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Lead 2");
    await goBack();

    // So does a parked (rejected) delete.
    await reconnect(setOffline);
    if (isSmall()) {
        // The mobile stage before the delete, which a parked delete restores.
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("New");
        expect(pipelineLeadNames()).toEqual(["Lead 2", "Lead 3"]);
        expect(".o_crm_mobile_pipeline_count").toHaveText("2");
    }
    await openLead(3);
    await setOffline(true);
    await deleteFromActionMenu();
    expect(".o_form_view").toHaveCount(0);
    if (isSmall()) {
        expect(pipelineLeadNames()).toEqual(["Lead 2"]);
        expect(".o_crm_mobile_pipeline_count").toHaveText("1");
    }
    rejection.reject = true;
    await reconnect(setOffline);
    expect.verifySteps([]);
    expect(queued("crm.lead")[0].value.extras.error).toBe(
        "odoo.exceptions.UserError - Deletion refused"
    );
    await openLead(3);
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Lead 3");
    expect(MockServer.env["crm.lead"].search_count([["id", "=", 3]])).toBe(1);
    if (isSmall()) {
        // Rendered from the cache, the mobile pipeline projects a parked delete as a
        // failed write rather than a removal. Desktop kanban cards carry no sync badge.
        await setOffline(true);
        await goBack();
        const card = await revealLeadCard("Lead 3");
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("New");
        expect(pipelineLeadNames()).toEqual(["Lead 2", "Lead 3"]);
        expect(`${card} .o_crm_mobile_pending_sync`).toHaveText("Sync failed");
        expect(`${card} .o_crm_mobile_pending_sync`).toHaveClass("text-bg-danger");
        expect(".o_crm_mobile_pipeline_count").toHaveText("2");
        await discardFromSystray("Lead 3");
        expect(queued("crm.lead")).toEqual([]);
        expect(pipelineLeadNames()).toEqual(["Lead 2", "Lead 3"]);
        expect(`${card} .o_crm_mobile_pending_sync`).toHaveCount(0);
        expect(".o_crm_mobile_pipeline_count").toHaveText("2");
    }
    expect.verifyErrors([
        LEAD_GROUPS_LOAD, // pipeline after the delete
        LEAD_RECORD_LOAD, // reopened lead 1
        LEAD_GROUPS_LOAD, // pipeline after leaving it again
        LEAD_GROUPS_LOAD, // pipeline after deleting lead 2
        ...(isSmall() ? [LEAD_GROUPS_LOAD] : []), // mobile pipeline reload after the discard
        LEAD_RECORD_LOAD, // lead 2 reopened after the discard
        LEAD_GROUPS_LOAD, // back to the pipeline
        LEAD_GROUPS_LOAD, // pipeline after deleting lead 3
        // Mobile pipeline: back to it offline with the parked delete, and its reload
        // after that delete is discarded.
        ...(isSmall() ? [LEAD_GROUPS_LOAD, LEAD_GROUPS_LOAD] : []),
    ]);
});

test("[Offline] mark won queues action_set_won and shows won", async () => {
    // Offline root loads served from the cache: back to the pipeline, reopened lead.
    expect.errors(2);
    const setOffline = mockOffline();
    // Every attempt of the rainbowman variant (a button call) or of the rainbowman
    // lookup, including one answered offline.
    stepRoutes(
        (route) =>
            route === RAINBOWMAN_ROUTE || route.endsWith("/crm.lead/action_set_won_rainbowman")
    );
    await openPipeline();
    await openLead(1);
    await flushStartupSync();
    expect(".ribbon:contains(Won)").toHaveCount(0);

    await setOffline(true);
    const wonButton = ".o_form_statusbar button[name=action_set_won_rainbowman]";
    expect(wonButton).toHaveAttribute("data-available-offline", "1");
    expect(wonButton).toBeEnabled();
    await contains(wonButton).click();

    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(".o_field_widget[name=probability]").toHaveText("100.00");
    expect(wonButton).toHaveCount(0);
    expect(".o_reward").toHaveCount(0);
    const won = {
        model: "crm.lead",
        method: "action_set_won",
        args: [[1]],
        kwargs: { context: queuedContext(PIPELINE_ACTION.context) },
    };
    expect(queuedCalls("crm.lead")).toEqual([won]);

    await goBack();
    await openLead(1);
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(".o_field_widget[name=probability]").toHaveText("100.00");
    // Never the rainbowman variant, never the rainbowman lookup.
    expect.verifySteps([]);

    await reconnect(setOffline);
    await expect.waitForSteps([won]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0]).toMatchObject({
        stage_id: STAGE_WON,
        won_status: "won",
        probability: 100,
    });
    await animationFrame();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(
        isSmall() ? ".o_statusbar_status .dropdown-toggle:visible" : ".o_arrow_button_current"
    ).toHaveText("Won");
    expect.verifySteps([]);
    expect.verifyErrors([LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] double-click on Won queues one action_set_won", async () => {
    const setOffline = mockOffline();
    let controller = null;
    patchWithCleanup(CrmFormController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    await openPipeline();
    await openLead(1);
    await flushStartupSync();
    const context = queuedContext(PIPELINE_ACTION.context);
    const wonCall = (resId) => ({
        model: "crm.lead",
        method: "action_set_won",
        args: [[resId]],
        kwargs: { context },
    });

    // A double-click whose second click lands once the first one is handled (the
    // form's buttons are enabled again) and before the render that hides "Won".
    await setOffline(true);
    const wonButton = queryFirst(".o_form_statusbar button[name=action_set_won_rainbowman]");
    await click(wonButton);
    for (let ticks = 0; wonButton.disabled && ticks < 100; ticks++) {
        await microTick();
    }
    expect(wonButton).toBeEnabled();
    expect(".ribbon:contains(Won)").toHaveCount(0);
    await click(wonButton);
    await animationFrame();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(".o_field_widget[name=probability]").toHaveText("100.00");
    expect(queuedCalls("crm.lead")).toEqual([wonCall(1)]);

    await reconnect(setOffline);
    await expect.waitForSteps([wonCall(1)]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].won_status).toBe("won");

    // Two calls of the button boundary at once, the second one starting while the
    // first one saves the lead's edit: the edit and one won call are queued.
    await goBack();
    await openLead(2);
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 2 won once");
    const clickParams = { type: "object", name: "action_set_won_rainbowman" };
    expect(
        await Promise.all([
            controller.beforeExecuteActionButton(clickParams),
            controller.beforeExecuteActionButton(clickParams),
        ])
    ).toEqual([false, false]);
    await animationFrame();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[2], { name: "Lead 2 won once" }],
            kwargs: { context, specification: {} },
        },
        wonCall(2),
    ]);

    await reconnect(setOffline);
    await expect.waitForSteps([wonCall(2)]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(2)[0]).toMatchObject({
        name: "Lead 2 won once",
        won_status: "won",
    });
});

test("[Offline] mark won saves pending edits first as their own web_save", async () => {
    stepWebSave();
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    // A held clock: the save and the won call are queued in the same millisecond,
    // so their order comes from the form, not from time passing between them.
    const clock = Date.now();
    patchWithCleanup(Date, { now: () => clock });
    // Edited, not saved: "Won" saves the edits before queueing the won call.
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 1 edited offline");
    await contains(".o_field_widget[name=expected_revenue] input").edit("15");
    await contains(".o_form_statusbar button[name=action_set_won_rainbowman]").click();

    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(".o_field_widget[name=probability]").toHaveText("100.00");
    expect(".o_form_status_indicator_buttons").toHaveClass("invisible");
    // The save holds the edits only: the won values are local, and the server sets
    // them (with the won stage) when it replays the won call.
    const context = queuedContext(PIPELINE_ACTION.context);
    const save = {
        model: "crm.lead",
        method: "web_save",
        args: [[1], { name: "Lead 1 edited offline", expected_revenue: 15 }],
        kwargs: { context, specification: {} },
    };
    const won = { model: "crm.lead", method: "action_set_won", args: [[1]], kwargs: { context } };
    expect(queuedCalls("crm.lead")).toEqual([save, won]);
    const [saveEntry, wonEntry] = queued("crm.lead");
    expect(wonEntry.key).not.toBe(saveEntry.key);
    expect(wonEntry.value.extras.timeStamp).toBeGreaterThan(saveEntry.value.extras.timeStamp);
    expect.verifySteps([]);

    await reconnect(setOffline);
    await expect.waitForSteps([save, won]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0]).toMatchObject({
        name: "Lead 1 edited offline",
        expected_revenue: 15,
        stage_id: STAGE_WON,
        won_status: "won",
        probability: 100,
    });
    await animationFrame();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 edited offline");
    expect.verifySteps([]);
});

test("[Offline] mark won with a missing required name saves and queues nothing", async () => {
    const setOffline = mockOffline();
    stepRoutes((route) =>
        /\/crm\.lead\/(web_save|action_set_won|action_set_won_rainbowman)$/.test(route)
    );
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    await setOffline(true);
    await contains(".o_field_widget[name=name] input").clear();
    await contains(".o_field_widget[name=expected_revenue] input").edit("15");
    await contains(".o_form_statusbar button[name=action_set_won_rainbowman]").click();

    // The save stops on the required name before any request, and "Won" with it.
    expect(queued("crm.lead")).toEqual([]);
    expect.verifySteps([]);
    expect(".o_field_widget[name=name]").toHaveClass("o_field_invalid");
    expect(".ribbon:contains(Won)").toHaveCount(0);
    expect(".o_form_statusbar button[name=action_set_won_rainbowman]").toHaveCount(1);
    expect(".o_field_widget[name=probability] input").toHaveValue("10.00");
    expect(".o_field_widget[name=name] input").toHaveValue("");
    expect(".o_field_widget[name=expected_revenue] input").toHaveValue("15.00");
    expect(".o_form_status_indicator_buttons").not.toHaveClass("invisible");

    // A valid form again: "Won" proceeds, with both edits in its save.
    await contains(".o_field_widget[name=name] input").edit("Lead 1 renamed");
    await contains(".o_form_statusbar button[name=action_set_won_rainbowman]").click();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    const context = queuedContext(PIPELINE_ACTION.context);
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { name: "Lead 1 renamed", expected_revenue: 15 }],
            kwargs: { context, specification: {} },
        },
        { model: "crm.lead", method: "action_set_won", args: [[1]], kwargs: { context } },
    ]);
    // The save's request is attempted, then queued when it fails offline; the won
    // call is queued without any attempt.
    expect.verifySteps(["/web/dataset/call_kw/crm.lead/web_save"]);
});

test("[Offline] mark won on an unsynced new lead queues its create only", async () => {
    // Offline root load served from the cache: the pipeline, back from the new lead.
    expect.errors(1);
    stepWebSave();
    const setOffline = mockOffline();
    await openPipeline();
    // Online: the pipeline's new-lead form, whose defaults are then cached.
    await getService("action").switchView("form");
    await animationFrame();
    await flushStartupSync();

    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Unsynced Lead");
    await contains(".o_field_widget[name=expected_revenue] input").edit("12");
    await contains(".o_form_statusbar button[name=action_set_won_rainbowman]").click();

    // The lead has no server id until its create replays: "Won" saves it and stops.
    // The create carries the new lead's delivery key.
    const deliveryKey = queuedCalls("crm.lead")[0]?.kwargs.context[CRM_OFFLINE_CREATE_KEY];
    expect(deliveryKey).toMatch(/^[0-9a-f]{32}$/);
    const create = {
        model: "crm.lead",
        method: "web_save",
        args: [
            [],
            {
                active: true,
                email_from: false,
                expected_revenue: 12,
                name: "Unsynced Lead",
                phone: false,
                probability: 0,
                stage_id: false,
                team_id: false,
                type: "opportunity",
                user_id: false,
                won_status: "pending",
            },
        ],
        kwargs: {
            context: {
                ...queuedContext(PIPELINE_ACTION.context),
                [CRM_OFFLINE_CREATE_KEY]: deliveryKey,
            },
            specification: {},
        },
    };
    expect(queuedCalls("crm.lead")).toEqual([create]);
    expect(".ribbon:contains(Won)").toHaveCount(0);
    expect(".o_form_statusbar button[name=action_set_won_rainbowman]").toHaveCount(1);
    expect(".o_field_widget[name=probability] input").toHaveValue("0.00");
    expect(".o_field_widget[name=name] input").toHaveValue("Unsynced Lead");
    expect(".o_field_widget[name=expected_revenue] input").toHaveValue("12.00");
    expect.verifySteps([]);

    await goBack();
    await reconnect(setOffline);
    await expect.waitForSteps([create]);
    expect(queued("crm.lead")).toEqual([]);
    const { env } = MockServer;
    const createdIds = env["crm.lead"].search([["name", "=", "Unsynced Lead"]]);
    expect(createdIds.length).toBe(1);
    expect(env["crm.lead"].browse(createdIds)[0]).toMatchObject({
        expected_revenue: 12,
        probability: 0,
        stage_id: false,
        won_status: "pending",
    });
    await animationFrame();
    expect.verifySteps([]);
    expect.verifyErrors([LEAD_GROUPS_LOAD]);
});

test("[Offline] non-secure origin disables Won, which queues and shows nothing", async () => {
    const setOffline = mockOffline();
    stepRoutes(
        (route) =>
            route === RAINBOWMAN_ROUTE ||
            /\/crm\.lead\/(web_save|action_set_won|action_set_won_rainbowman)$/.test(route)
    );
    let controller = null;
    patchWithCleanup(CrmFormController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    await openPipeline();
    // A non-secure origin (a plain-http LAN address), where the framework queue
    // refuses every call: set before the form renders, as it holds for a whole
    // session, and after the web client started, so its caches stay as opened.
    patchWithCleanup(window, { isSecureContext: false });
    await openLead(1);
    await flushStartupSync();

    // Online, "Won" is unchanged.
    const wonButton = ".o_form_statusbar button[name=action_set_won_rainbowman]";
    expectUnguarded(wonButton, 1);
    expect(wonButton).toHaveAttribute("data-available-offline", "1");

    // Offline it is a DISABLE button: framework-disabled, without the attribute
    // by which the framework would enable it again, and inert by pointer, keyboard
    // and hotkey.
    await setOffline(true);
    expectGuarded(wonButton, 1);
    expect(wonButton).not.toHaveAttribute("data-available-offline");
    await activateByPointerAndKeyboard(wonButton);
    await press(["alt", "w"]);
    await animationFrame();
    expect(".ribbon:contains(Won)").toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_notification").toHaveCount(0);
    expect.verifySteps([]);

    // A direct call is refused by the framework queue before any local won state.
    await expect(controller.crmQueueMarkWon()).rejects.toThrow(/non-secure context/);
    await animationFrame();
    expect(".ribbon:contains(Won)").toHaveCount(0);
    expect(".o_field_widget[name=probability] input").toHaveValue("10.00");
    expect(queued("crm.lead")).toEqual([]);
    expect.verifySteps([]);

    // Online again, "Won" is enabled and marks the lead won on the server.
    await setOffline(false);
    await animationFrame();
    expectUnguarded(wonButton, 1);
    expect(wonButton).toHaveAttribute("data-available-offline", "1");
    await contains(wonButton).click();
    await expect.waitForSteps([
        buttonRoute("crm.lead", "action_set_won_rainbowman"),
        "action_set_won_rainbowman [1]",
    ]);
    await animationFrame();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_notification").toHaveCount(0);
});

/**
 * Asserts the framework's offline state of controls that dropped
 * `data-available-offline`: disabled and dimmed by the framework.
 */
function expectFrameworkDisabled(selector) {
    expect(selector).not.toHaveCount(0);
    for (const el of queryAll(selector)) {
        expect(el).not.toHaveAttribute("data-available-offline");
        expect(el).toHaveClass("o_disabled_offline");
        expect(el).not.toBeEnabled();
    }
}

/** Asserts controls carrying `data-available-offline`, enabled and not dimmed. */
function expectAvailableOffline(selector) {
    expect(selector).not.toHaveCount(0);
    for (const el of queryAll(selector)) {
        expect(el).toHaveAttribute("data-available-offline", "1");
        expect(el).not.toHaveClass("o_disabled_offline");
        expect(el).toBeEnabled();
    }
}

test.tags("desktop");
test("[Offline] non-secure origin disables the card menu toggle and colours, which change nothing", async () => {
    const setOffline = mockOffline();
    stepRoutes((route) => /\/(crm\.lead|crm\.team)\/web_save$/.test(route));
    await mountWithCleanup(WebClient);
    // A non-secure origin, where the framework queue refuses every call (see the
    // "Won" test above).
    patchWithCleanup(window, { isSecureContext: false });
    await getService("action").doAction(PIPELINE_ACTION.id);
    await flushStartupSync();
    const card = ".o_kanban_record:contains(Lead 1)";
    const toggle = `${card} .o_dropdown_kanban .dropdown-toggle`;
    const colours = ".o-dropdown--menu .o_kanban_colorpicker button";
    expect(card).toHaveClass("o_kanban_color_0");

    // Online, the toggle and the colours of a menu opened online keep the attribute.
    expectAvailableOffline(toggle);
    await contains(toggle, { visible: false }).click();
    expect(colours).toHaveCount(12);
    expectAvailableOffline(colours);

    // Offline the colour write cannot be queued: the colours of the open menu and the
    // toggle are framework-disabled, and a forced click changes and queues nothing.
    await setOffline(true);
    await animationFrame();
    expectFrameworkDisabled(colours);
    expectFrameworkDisabled(toggle);
    forceClick(".o-dropdown--menu .o_colorlist_item_color_1");
    await animationFrame();
    expect(card).toHaveClass("o_kanban_color_0");
    expect(card).not.toHaveClass("o_kanban_color_1");
    await click(queryFirst(toggle));
    await animationFrame();
    expect(".o-dropdown--menu").toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_notification").toHaveCount(0);
    expect.verifySteps([]);

    // Online again, both are enabled with the attribute and the colour is saved.
    await setOffline(false);
    await animationFrame();
    expectAvailableOffline(toggle);
    await contains(toggle, { visible: false }).click();
    expectAvailableOffline(colours);
    await contains(".o-dropdown--menu .o_colorlist_item_color_3").click();
    await expect.waitForSteps(["/web/dataset/call_kw/crm.lead/web_save"]);
    expect(card).toHaveClass("o_kanban_color_3");
    expect(MockServer.env["crm.lead"].browse(1)[0].color).toBe(3);

    // The sales-team card colours of a menu opened online behave the same.
    await getService("action").doAction(TEAM_ACTION.id);
    await contains(EUROPE_MENU_TOGGLE, { visible: false }).click();
    expectAvailableOffline(colours);
    await setOffline(true);
    await animationFrame();
    expectFrameworkDisabled(colours);
    forceClick(".o-dropdown--menu .o_colorlist_item_color_5");
    await animationFrame();
    expect(EUROPE_CARD).toHaveClass("o_kanban_color_1");
    expect(queued("crm.team")).toEqual([]);
    expect(".o_notification").toHaveCount(0);
    expect.verifySteps([]);
    await setOffline(false);
    await animationFrame();
    await contains(EUROPE_MENU_TOGGLE, { visible: false }).click();
    expectAvailableOffline(colours);
});

// Refine D2.7 (U7): on a non-secure origin, the Delete of a lead card menu opened
// online is disabled and inert offline, instead of opening a confirmation whose
// delete only ends in the framework's non-secure-context notification. On a secure
// origin it still confirms and queues `unlink`.

/** Delete of the open card menu. */
const CARD_MENU_DELETE = ".o-dropdown--menu .dropdown-item:contains(Delete)";

/** Asserts a usable card-menu Delete: a plain item of the dropdown's navigation. */
function expectCardDeleteUsable() {
    expect(CARD_MENU_DELETE).toHaveCount(1);
    expect(CARD_MENU_DELETE).not.toHaveClass("o_disabled_offline");
    expect(CARD_MENU_DELETE).not.toHaveClass("pe-none");
    expect(CARD_MENU_DELETE).not.toHaveAttribute("aria-disabled");
    expect(CARD_MENU_DELETE).not.toHaveAttribute("tabindex");
    expect(CARD_MENU_DELETE).not.toHaveAttribute("inert");
    expect(CARD_MENU_DELETE).toHaveClass("o-navigable");
}

/**
 * Asserts a disabled card-menu Delete: dimmed with the framework's offline state,
 * announced as disabled, out of the tab order and of the dropdown's navigation.
 */
function expectCardDeleteDisabled() {
    expect(CARD_MENU_DELETE).toHaveCount(1);
    expect(CARD_MENU_DELETE).toHaveClass(["o_disabled_offline", "pe-none"]);
    expect(CARD_MENU_DELETE).toHaveAttribute("aria-disabled", "true");
    expect(CARD_MENU_DELETE).toHaveAttribute("tabindex", "-1");
    expect(CARD_MENU_DELETE).toHaveAttribute("inert");
    expect(CARD_MENU_DELETE).not.toHaveClass("o-navigable");
    expect(getFocusableElements({ tabbable: true })).not.toInclude(queryFirst(CARD_MENU_DELETE));
}

test.tags("desktop");
test("[Offline] non-secure origin disables Delete in a lead card menu opened online, which deletes nothing", async () => {
    let leadCard = null;
    patchWithCleanup(KanbanRecord.prototype, {
        setup() {
            super.setup(...arguments);
            if (this.props.record.resModel === "crm.lead" && this.props.record.resId === 1) {
                leadCard = this;
            }
        },
    });
    const setOffline = mockOffline();
    // Every unlink request, offline attempts included.
    stepRoutes((route) => route === "/web/dataset/call_kw/crm.lead/unlink");
    await mountWithCleanup(WebClient);
    // A non-secure origin, where the framework queue refuses every call (see the
    // "Won" test above).
    patchWithCleanup(window, { isSecureContext: false });
    await getService("action").doAction(PIPELINE_ACTION.id);
    await flushStartupSync();
    const card = ".o_kanban_record:contains(Lead 1)";
    const toggle = `${card} .o_dropdown_kanban .dropdown-toggle`;
    const columnTitles = queryAllTexts(".o_kanban_group .o_column_title");

    // Online, the menu's Delete is a plain item, which the keyboard reaches.
    await contains(toggle, { visible: false }).click();
    expectCardDeleteUsable();
    await press("Tab");
    await press("Tab");
    await animationFrame();
    expect(CARD_MENU_DELETE).toBeFocused();
    expect(CARD_MENU_DELETE).toHaveClass("focus");

    // Offline the unlink cannot be queued: in that open menu Delete is disabled, has
    // lost the focus it had online, and no key of the menu reaches it. The menu has
    // no other item to navigate: its Edit is gone, as Lead 1's form was not opened
    // online, and its colours are framework-disabled.
    await setOffline(true);
    await animationFrame();
    expectCardDeleteDisabled();
    expect(CARD_MENU_DELETE).not.toBeFocused();
    expect(CARD_MENU_DELETE).not.toHaveClass("focus");
    expect(".o-dropdown--menu .dropdown-item:contains(Edit)").toHaveCount(0);
    expectFrameworkDisabled(".o-dropdown--menu .o_kanban_colorpicker button");
    for (const keys of ["Tab", "Tab", ["Shift", "Tab"], "ArrowDown", "ArrowUp", "Home", "End"]) {
        await press(keys);
        await animationFrame();
        expect(CARD_MENU_DELETE).not.toBeFocused();
        expect(CARD_MENU_DELETE).not.toHaveClass("focus");
    }

    // Neither Enter, a pointer click, a script's click nor a direct call of the
    // card's delete trigger, which the item calls, confirms, notifies, requests or
    // queues anything: the card and its column stay, and so does the menu, which
    // could not be reopened offline.
    queryFirst(CARD_MENU_DELETE).focus();
    expect(CARD_MENU_DELETE).not.toBeFocused();
    await press("Enter");
    await settle();
    expect(".modal").toHaveCount(0);
    // The item takes no pointer: a pointer at its centre hits the menu under it.
    expect(`${CARD_MENU_DELETE}:interactive`).toHaveCount(0);
    const deleteEl = queryFirst(CARD_MENU_DELETE);
    const { x, y, width, height } = deleteEl.getBoundingClientRect();
    const hitEl = document.elementFromPoint(x + width / 2, y + height / 2);
    expect(deleteEl.contains(hitEl)).toBe(false, {
        message: "the disabled Delete is not the element under its own centre",
    });
    expect(queryFirst(".o-dropdown--menu").contains(hitEl)).toBe(true, {
        message: "the open menu is under the disabled Delete",
    });
    await click(hitEl);
    await settle();
    expect(".modal").toHaveCount(0);
    expect(".o-dropdown--menu").toHaveCount(1);
    const scriptClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    queryFirst(CARD_MENU_DELETE).dispatchEvent(scriptClick);
    // Its `href="#"` is not followed either.
    expect(scriptClick.defaultPrevented).toBe(true);
    await settle();
    expect(".o-dropdown--menu").toHaveCount(1);
    await leadCard.triggerAction({ type: "delete" });
    await settle();
    expect(".modal").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
    expect(card).toHaveCount(1);
    expect(queryAllTexts(".o_kanban_group .o_column_title")).toEqual(columnTitles);
    expect(MockServer.env["crm.lead"].search_count([["id", "=", 1]])).toBe(1);
    expectCardDeleteDisabled();
    expect.verifySteps([]);

    // Online again, in the same open menu, Delete is a plain item: it confirms and
    // deletes the lead on the server.
    await setOffline(false);
    await animationFrame();
    expectCardDeleteUsable();
    await contains(CARD_MENU_DELETE).click();
    expect(".modal").toHaveCount(1);
    await contains(".modal-footer .btn-danger").click();
    await expect.waitForSteps(["/web/dataset/call_kw/crm.lead/unlink"]);
    expect(card).toHaveCount(0);
    expect(MockServer.env["crm.lead"].search_count([["id", "=", 1]])).toBe(0);
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_notification").toHaveCount(0);
});

test.tags("desktop");
test("[Offline] secure origin keeps Delete usable in a lead card menu opened online, which queues unlink", async () => {
    stepCalls("crm.lead", "unlink");
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    // A secure origin (HTTPS or localhost), where the framework queue holds calls.
    patchWithCleanup(window, { isSecureContext: true });
    await getService("action").doAction(PIPELINE_ACTION.id);
    await flushStartupSync();
    const card = ".o_kanban_record:contains(Lead 1)";
    const toggle = `${card} .o_dropdown_kanban .dropdown-toggle`;

    await contains(toggle, { visible: false }).click();
    expectCardDeleteUsable();

    // Offline, Delete of that open menu stays a plain item: it confirms, hides the
    // card at once and queues `unlink`, which replays on reconnection.
    await setOffline(true);
    await animationFrame();
    expectCardDeleteUsable();
    await contains(CARD_MENU_DELETE).click();
    expect(".modal").toHaveCount(1);
    await contains(".modal-footer .btn-danger").click();
    expect(card).toHaveCount(0);
    expect(".o_kanban_group:eq(0) .o_column_title").toHaveText("New\n(2)");
    const unlink = {
        model: "crm.lead",
        method: "unlink",
        args: [[1]],
        kwargs: { context: queuedContext(PIPELINE_ACTION.context) },
    };
    expect(queuedCalls("crm.lead")).toEqual([unlink]);
    expect(".o_notification").toHaveCount(0);
    expect.verifySteps([]);
    await reconnect(setOffline);
    await expect.waitForSteps([unlink]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].search_count([["id", "=", 1]])).toBe(0);
});


test("[Offline] non-secure origin disables the lead form statusbar, which changes no stage", async () => {
    const setOffline = mockOffline();
    stepRoutes((route) => route === "/web/dataset/call_kw/crm.lead/web_save");
    await openPipeline();
    // A non-secure origin (see the "Won" test above), set before the form renders.
    patchWithCleanup(window, { isSecureContext: false });
    await openLead(1);
    await flushStartupSync();
    const currentStage = isSmall()
        ? ".o_statusbar_status .dropdown-toggle:visible"
        : ".o_arrow_button_current";
    const choosable = ".o_statusbar_status button:visible:not(.o_arrow_button_current)";
    const stageItems = ".o-dropdown--menu .dropdown-item";
    expect(currentStage).toHaveText("New");

    // Online every statusbar button keeps the attribute; on the mobile preset the
    // all-stages menu is opened online, its stage items keep it too.
    for (const button of queryAll(".o_statusbar_status button")) {
        expect(button).toHaveAttribute("data-available-offline", "1");
    }
    expectAvailableOffline(choosable);
    if (isSmall()) {
        await contains(".o_statusbar_status button.dropdown-toggle").click();
        expect(stageItems).toHaveCount(3);
        for (const item of queryAll(stageItems)) {
            expect(item).toHaveAttribute("data-available-offline", "1");
            expect(item).not.toHaveAttribute("aria-disabled");
            expect(item).not.toHaveClass("o_disabled_offline");
        }
    }

    // Offline the stage save cannot be queued: the buttons are framework-disabled,
    // the stage items of the open menu are dimmed and announced disabled, and no
    // click, forced click or "move to next stage" shortcut changes the stage.
    await setOffline(true);
    await animationFrame();
    for (const button of queryAll(".o_statusbar_status button")) {
        expect(button).not.toHaveAttribute("data-available-offline");
        expect(button).not.toBeEnabled();
    }
    expectFrameworkDisabled(choosable);
    if (isSmall()) {
        expect(stageItems).toHaveCount(3);
        for (const item of queryAll(stageItems)) {
            expect(item).not.toHaveAttribute("data-available-offline");
            expect(item).toHaveAttribute("aria-disabled", "true");
            expect(item).toHaveClass("o_disabled_offline");
        }
        await click(queryFirst(`${stageItems}:contains(Qualified)`));
        await animationFrame();
    } else {
        forceClick(`.o_statusbar_status button[data-value='${STAGE_QUALIFIED}']`);
        await animationFrame();
    }
    await press(["alt", "x"]);
    await animationFrame();
    expect(currentStage).toHaveText("New");
    expect(".o_form_status_indicator_buttons").toHaveClass("invisible");
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_notification").toHaveCount(0);
    expect.verifySteps([]);

    // Online again, the statusbar is enabled with the attribute and saves a stage.
    await setOffline(false);
    await animationFrame();
    for (const button of queryAll(".o_statusbar_status button")) {
        expect(button).toHaveAttribute("data-available-offline", "1");
        expect(button).not.toHaveClass("o_disabled_offline");
    }
    expectAvailableOffline(choosable);
    await selectStage(STAGE_QUALIFIED, "Qualified");
    expect(currentStage).toHaveText("Qualified");
    await contains(".o_form_button_save").click();
    await expect.waitForSteps(["/web/dataset/call_kw/crm.lead/web_save"]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_QUALIFIED);
    expect(queued("crm.lead")).toEqual([]);
});

/**
 * Makes the next root load of a lead form (`crm.lead/web_read`) fail once, as set in
 * the returned state: `"lost"` answers 502 (the connection drops during the request,
 * the framework goes offline until its next connection check), `"refused"` raises a
 * server error whose message is "Lead reload refused". Each failure is stepped. Must be
 * called after `mockOffline()`, so the 502 answer is given online.
 */
function failNextLeadLoad() {
    const state = { next: false };
    onRpc("crm.lead", "web_read", () => {
        if (state.next === "refused") {
            state.next = false;
            expect.step("web_read refused");
            throw makeServerError({ message: "Lead reload refused" });
        }
    });
    onRpc("/*", (request) => {
        if (state.next === "lost" && new URL(request.url).pathname === LEAD_RECORD_LOAD) {
            state.next = false;
            expect.step("web_read lost");
            return new Response("", { status: 502 });
        }
    });
    return state;
}

/**
 * Marks the displayed lead of "My Pipeline" won offline: one queued `action_set_won`
 * for `resId`, whose payload is returned.
 */
async function markWonOffline(setOffline, resId) {
    await setOffline(true);
    await contains(".o_form_statusbar button[name=action_set_won_rainbowman]").click();
    const won = {
        model: "crm.lead",
        method: "action_set_won",
        args: [[resId]],
        kwargs: { context: queuedContext(PIPELINE_ACTION.context) },
    };
    expect(queuedCalls("crm.lead")).toEqual([won]);
    return won;
}

test("[Offline] lead form reload after a replay ignores a lost connection, reports an error once", async () => {
    // The server error injected into the second reload, shown by the framework.
    expect.errors(1);
    const failure = failNextLeadLoad();
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    // The connection drops again during the reload that follows the replay: the
    // replay is kept, nothing is raised, and the web client comes back online.
    const firstWon = await markWonOffline(setOffline, 1);
    failure.next = "lost";
    await reconnect(setOffline);
    await expect.waitForSteps([firstWon, "web_read lost"]);
    await settle();
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].won_status).toBe("won");
    expect(getService(OfflinePlugin).isOffline()).toBe(false);
    expect(".o_error_dialog").toHaveCount(0);
    expect.verifyErrors([]);

    // A server error on that reload reaches the framework error handling once, as
    // its standard dialog.
    await goBack();
    await openLead(2);
    const secondWon = await markWonOffline(setOffline, 2);
    failure.next = "refused";
    await reconnect(setOffline);
    await expect.waitForSteps([secondWon, "web_read refused"]);
    await waitFor(".o_error_dialog:contains(Lead reload refused)");
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(2)[0].won_status).toBe("won");
    expect.verifyErrors(["Lead reload refused"]);
});

test("[Offline] lead form reload after a discard ignores a lost connection, reports an error once", async () => {
    // The server error injected into the second reload, shown by the framework.
    expect.errors(1);
    const failure = failNextLeadLoad();
    const rejection = rejectReplay("crm.lead", "action_set_won", "Won refused");
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(3);
    await flushStartupSync();

    /**
     * Parks the won of `resId` (rejected replay), then discards it online, the
     * reload that follows failing as `reloadFailure`.
     */
    async function discardParkedWon(resId, displayName, reloadFailure) {
        await markWonOffline(setOffline, resId);
        rejection.reject = true;
        await reconnect(setOffline);
        rejection.reject = false;
        expectParked("crm.lead", "Won refused");
        failure.next = reloadFailure;
        await discardFromSystray(displayName);
    }

    // The connection drops during the reload that follows the discard: nothing is
    // raised, and the web client comes back online.
    await discardParkedWon(3, "Lead 3", "lost");
    await expect.waitForSteps(["web_read lost"]);
    await settle();
    expect(queued("crm.lead")).toEqual([]);
    expect(getService(OfflinePlugin).isOffline()).toBe(false);
    expect(".o_error_dialog").toHaveCount(0);
    expect.verifyErrors([]);

    // A server error on that reload reaches the framework error handling once.
    await goBack();
    await openLead(4);
    await discardParkedWon(4, "Lead 4", "refused");
    await expect.waitForSteps(["web_read refused"]);
    await waitFor(".o_error_dialog:contains(Lead reload refused)");
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(4)[0].won_status).not.toBe("won");
    expect.verifyErrors(["Lead reload refused"]);
});

test("[Offline] replay and discard callbacks: the hooks own the promises they return", async () => {
    // The two non-connection failures returned below, one per hook.
    expect.errors(2);
    /** Makes the promise the next callback returns, per hook (nothing when unset). */
    const outcomes = { replayed: null, discarded: null };
    class CallbackOwner extends Component {
        static template = xml`<div class="o_crm_callback_owner"/>`;
        static props = {};

        setup() {
            const crmOffline = useCrmOffline();
            crmOffline.onReplayed(() => {
                expect.step("replayed");
                return outcomes.replayed?.();
            });
            crmOffline.onEntriesDiscarded("crm.lead", () => {
                expect.step("discarded");
                return outcomes.discarded?.();
            });
        }
    }
    const lostConnection = () => Promise.reject(new ConnectionLostError("/web/dataset/call_kw"));
    const setOffline = mockOffline();
    await mountWithCleanup(CallbackOwner);
    await flushStartupSync();
    await expect.waitForSteps(["replayed"]);
    const offlinePlugin = getService(OfflinePlugin);

    // After a replay: a lost connection is ignored, any other error is reported once.
    outcomes.replayed = lostConnection;
    await setOffline(true);
    await reconnect(setOffline);
    await expect.waitForSteps(["replayed"]);
    expect.verifyErrors([]);
    outcomes.replayed = () => Promise.reject(new Error("Replay callback failed"));
    await setOffline(true);
    await reconnect(setOffline);
    await expect.waitForSteps(["replayed"]);
    expect.verifyErrors(["Replay callback failed"]);

    /** Queues a lead write offline, then discards it from the queue. */
    async function discardQueuedWrite() {
        await setOffline(true);
        const args = [[1], { name: "Lead 1 (discarded)" }];
        const options = { extras: { timeStamp: Date.now() } };
        const key = offlinePlugin.scheduleORM("crm.lead", "write", args, {}, options);
        await animationFrame();
        offlinePlugin.removeScheduledORM(key);
        await animationFrame();
    }

    // After a discard: the same.
    outcomes.discarded = lostConnection;
    await discardQueuedWrite();
    await expect.waitForSteps(["discarded"]);
    expect.verifyErrors([]);
    outcomes.discarded = () => Promise.reject(new Error("Discard callback failed"));
    await discardQueuedWrite();
    await expect.waitForSteps(["discarded"]);
    expect.verifyErrors(["Discard callback failed"]);
    // A callback returning nothing is unaffected.
    outcomes.discarded = null;
    await discardQueuedWrite();
    await expect.waitForSteps(["discarded"]);
    expect(queued("crm.lead")).toEqual([]);
    expect.verifyErrors([]);
});

/**
 * Names of the leads the pipeline displays: every kanban card on desktop, the cards
 * of the displayed stage on the mobile pipeline.
 */
function pipelineLeadNames() {
    return isSmall()
        ? queryAllTexts(".o_crm_mobile_lead_card .o_crm_mobile_lead_name")
        : queryAllTexts(".o_kanban_record:not(.o_kanban_ghost) span.fw-bold");
}

/**
 * Stage names of the pipeline: the column titles on desktop; on the mobile pipeline,
 * the stage header of each stage, browsed with "Next stage" from the first one (the
 * pipeline shows again the stage it was left at, so "Previous stage" reaches it first).
 */
async function pipelineStageNames() {
    if (!isSmall()) {
        // A column title is followed by its record count, e.g. "New\n(3)".
        return queryAllTexts(".o_kanban_group .o_column_title").map((text) => text.split("\n")[0]);
    }
    while (queryFirst(".o_crm_mobile_pipeline_prev:enabled")) {
        await contains(".o_crm_mobile_pipeline_prev").click();
    }
    const names = [queryFirst(".o_crm_mobile_pipeline_stage_name").textContent];
    while (queryFirst(".o_crm_mobile_pipeline_next:enabled")) {
        await contains(".o_crm_mobile_pipeline_next").click();
        names.push(queryFirst(".o_crm_mobile_pipeline_stage_name").textContent);
    }
    return names;
}

/**
 * Search facets of the displayed view, showing the mobile search bar first. The
 * framework's offline search bar adds an icon-only "clear search" control styled as
 * a facet; it has no text and is left out.
 */
async function readFacets() {
    if (isSmall() && !queryAll(".o_searchview_facet").length) {
        await contains(".o_control_panel_navigation button:has(.fa-search)").click();
    }
    return getFacetTexts().filter(Boolean);
}

/** Opens a team's pipeline from its dashboard card menu ("Opportunities" link). */
async function openTeamPipeline(teamName) {
    await contains(`.o_kanban_record:contains(${teamName}) .o_dropdown_kanban .dropdown-toggle`, {
        visible: false,
    }).click();
    await contains(`.o-dropdown--menu a[name='${TEAM_PIPELINE_ACTION_ID}']`).click();
}

test("[Offline] cached stages, teams and team facet", async () => {
    // Offline root loads served from the cache: the dashboard and the pipeline (each
    // restored from the breadcrumbs) and the lead.
    expect.errors(3);
    const setOffline = mockOffline();
    await openPipeline();
    // Online visits: the pipeline, a lead, the Sales Teams dashboard and a team pipeline.
    expect(await pipelineStageNames()).toEqual(["New", "Qualified", "Won"]);
    await openLead(1);
    await goBack();
    await getService("action").doAction(TEAM_ACTION.id);
    await openTeamPipeline("Europe");
    expect(await readFacets()).toEqual(["Sales Team\nEurope"]);
    await flushStartupSync();

    await setOffline(true);
    expect(await readFacets()).toEqual(["Sales Team\nEurope"]);
    expect(pipelineLeadNames()).toEqual(["Lead 1", "Lead 2"]);

    // The Sales Teams dashboard renders its cached team cards.
    await goBack();
    expect(".o_kanban_view .o_kanban_record:not(.o_kanban_ghost)").toHaveCount(2);
    expect(queryAllTexts(".o_kanban_record:not(.o_kanban_ghost) span.fw-bold")).toEqual([
        "Europe",
        "America",
    ]);

    // The pipeline renders from the cache with every stage.
    await goBack();
    expect(".o_kanban_view").toHaveCount(1);
    expect(await pipelineStageNames()).toEqual(["New", "Qualified", "Won"]);

    // The lead form resolves its stage and team names.
    await openLead(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1");
    expect(
        isSmall() ? ".o_statusbar_status .dropdown-toggle:visible" : ".o_arrow_button_current"
    ).toHaveText("New");
    expect(".o_field_widget[name=team_id] input").toHaveValue("Europe");
    expect.verifyErrors([
        "/web/dataset/call_kw/crm.team/web_search_read",
        LEAD_GROUPS_LOAD,
        LEAD_RECORD_LOAD,
    ]);
});

test("[Offline] selected team stays a search facet", async () => {
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(TEAM_ACTION.id);
    await openTeamPipeline("Europe");
    await flushStartupSync();
    expect(await readFacets()).toEqual(["Sales Team\nEurope"]);
    expect(pipelineLeadNames()).toEqual(["Lead 1", "Lead 2"]);

    await setOffline(true);
    expect(await readFacets()).toEqual(["Sales Team\nEurope"]);
    expect(pipelineLeadNames()).toEqual(["Lead 1", "Lead 2"]);

    await reconnect(setOffline);
    expect(await readFacets()).toEqual(["Sales Team\nEurope"]);
    expect(pipelineLeadNames()).toEqual(["Lead 1", "Lead 2"]);
});

// -----------------------------------------------------------------------------
// DISABLE: CRM controls unreachable offline (click, keyboard, hotkey, direct call)
// -----------------------------------------------------------------------------

/** Opportunities list and full lead form (`crm.crm_lead_opportunities`). */
const LEADS_ACTION = {
    id: 40,
    xml_id: "crm.crm_lead_opportunities",
    name: "Opportunities",
    res_model: "crm.lead",
    views: [
        [LEAD_LIST_VIEW_ID, "list"],
        [LEAD_FULL_FORM_VIEW_ID, "form"],
    ],
    context: { default_type: "opportunity" },
};

/** "Mark Lost" wizard, bound to the lead list and form (`crm.crm_lead_lost_action`). */
const LOST_ACTION = {
    id: LOST_ACTION_ID,
    xml_id: "crm.crm_lead_lost_action",
    name: "Mark Lost",
    res_model: "crm.lead.lost",
    target: "new",
    views: [[false, "form"]],
    binding_view_types: "list,form",
    context: "{'dialog_size': 'medium', 'default_lead_ids': active_ids}",
};

/** Mass conversion wizard of the Leads list header (`crm.action_crm_send_mass_convert`). */
const MASS_CONVERT_ACTION = {
    id: MASS_CONVERT_ACTION_ID,
    xml_id: "crm.action_crm_send_mass_convert",
    name: "Convert to Opportunities",
    res_model: "crm.lead2opportunity.partner.mass",
    target: "new",
    views: [[false, "form"]],
    context: { dialog_size: "large" },
};

/** Merge wizard, bound to the lead list and kanban (`crm.action_merge_opportunities`). */
const MERGE_ACTION = {
    id: 23,
    xml_id: "crm.action_merge_opportunities",
    name: "Merge",
    res_model: "crm.merge.opportunity",
    target: "new",
    views: [[false, "form"]],
    binding_view_types: "list,kanban",
    context: "{'default_opportunity_ids': active_ids}",
};

/** Probability update wizard of the CRM settings (`crm.crm_lead_pls_update_action`). */
const PLS_UPDATE_ACTION = {
    id: 24,
    xml_id: "crm.crm_lead_pls_update_action",
    name: "Update Probabilities",
    res_model: "crm.lead.pls.update",
    target: "new",
    views: [[false, "form"]],
};

/** "Send email", bound to the lead form (`crm.action_lead_mail_compose`). */
const MAIL_COMPOSE_ACTION = {
    id: MAIL_COMPOSE_ACTION_ID,
    xml_id: "crm.action_lead_mail_compose",
    name: "Send email",
    res_model: "mail.compose.message",
    target: "new",
    views: [[false, "form"]],
    binding_view_types: "form",
};

/** "Send email" (mass mail), bound to the lead list and kanban (`crm.action_lead_mass_mail`). */
const MASS_MAIL_ACTION = {
    id: MASS_MAIL_ACTION_ID,
    xml_id: "crm.action_lead_mass_mail",
    name: "Send email",
    res_model: "mail.compose.message",
    target: "new",
    views: [[false, "form"]],
    binding_view_types: "list,kanban",
};

/** "Add/Remove Followers", bound to the lead list and kanban. */
const FOLLOWERS_ACTION = {
    id: 27,
    xml_id: "crm.mail_followers_edit_action_from_lead",
    name: "Add/Remove Followers",
    res_model: "mail.followers.edit",
    target: "new",
    views: [[false, "form"]],
    binding_view_types: "list,kanban",
    context: "{'default_res_model': 'crm.lead'}",
};

/** Lead meetings (`crm.act_crm_opportunity_calendar_event_new`, `list,form,calendar`). */
const MEETING_ACTION = {
    id: 28,
    xml_id: "crm.act_crm_opportunity_calendar_event_new",
    name: "Meetings",
    res_model: "calendar.event",
    views: [
        [false, "list"],
        [false, "form"],
        [false, "calendar"],
    ],
};

defineActions([
    LEADS_ACTION,
    LOST_ACTION,
    MASS_CONVERT_ACTION,
    MERGE_ACTION,
    PLS_UPDATE_ACTION,
    MAIL_COMPOSE_ACTION,
    MASS_MAIL_ACTION,
    FOLLOWERS_ACTION,
    MEETING_ACTION,
]);

/** Route of a `call_button` request. */
function buttonRoute(model, method) {
    return `/web/dataset/call_button/${model}/${method}`;
}

/**
 * Calls the action service's button entry point directly, as a view button does
 * (the execution boundary every DISABLE button reaches).
 */
function callButton({ resModel, name, resId, type = "object", context = {} }) {
    return getService("action").doActionButton({
        type,
        name,
        resModel,
        resId,
        resIds: resId ? [resId] : [],
        context,
        buttonContext: {},
    });
}

/**
 * Asserts the offline DISABLE state of guarded CRM view buttons: framework-disabled,
 * dimmed, out of the tab order and announced as disabled.
 */
function expectGuarded(selector, count) {
    expect(selector).toHaveCount(count);
    const tabbable = getFocusableElements({ tabbable: true });
    for (const el of queryAll(selector)) {
        expect(el).toHaveClass(["o_disabled_offline", "pe-none"]);
        expect(el).toHaveAttribute("aria-disabled", "true");
        expect(el).toHaveAttribute("tabindex", "-1");
        expect(el).toHaveAttribute("disabled");
        expect(tabbable).not.toInclude(el);
        if (el.tagName === "A") {
            // Guarded links are out of hit-testing: `pe-none` wins over the framework's
            // `.o_disabled_offline { pointer-events: auto !important }`.
            expect(el).toHaveClass("o_crm_offline_guarded");
            expect(el).toHaveStyle({ "pointer-events": "none" });
        }
    }
}

/** Asserts that guarded CRM view buttons are back to their online state. */
function expectUnguarded(selector, count) {
    expect(selector).toHaveCount(count);
    for (const el of queryAll(selector)) {
        expect(el).not.toHaveClass("o_disabled_offline");
        expect(el).not.toHaveClass("o_crm_offline_guarded");
        expect(el).not.toHaveAttribute("aria-disabled");
        expect(el).not.toHaveAttribute("tabindex");
        expect(el).not.toHaveAttribute("disabled");
    }
}

/**
 * Activates every displayed control matching `selector` the ways a user can: pointer
 * click, then Enter and Space on the focused element.
 */
async function activateByPointerAndKeyboard(selector) {
    for (const el of queryAll(`${selector}:visible`)) {
        await click(el);
        // A disabled button cannot take the focus (no keyboard path at all); a
        // guarded link can only be focused programmatically (tabindex -1).
        el.focus();
        if (document.activeElement === el) {
            await press("Enter");
            await press(" ");
        }
    }
    await animationFrame();
}

/**
 * Forces the activation of a button the framework disabled offline, as a script can:
 * its `disabled` attribute is removed, then it is clicked at once, before the
 * framework disables it again.
 *
 * @param {string} selector
 */
function forceClick(selector) {
    const el = queryFirst(selector);
    el.removeAttribute("disabled");
    el.click();
}

/**
 * On the mobile preset, opens the form menu that holds a control: the statusbar
 * "More" menu (every header button after the first one) or the button box menu
 * (every smart button). Desktop renders both inline. A toggle the framework
 * disables offline is left closed: the control is then unreachable.
 */
async function revealFormControl(selector) {
    if (!isSmall() || queryAll(selector).length) {
        return;
    }
    for (const toggle of [
        ".o_statusbar_buttons button[title=More]",
        ".o-form-buttonbox .o_button_more",
    ]) {
        const toggleEl = queryFirst(toggle);
        if (toggleEl && !toggleEl.disabled) {
            await contains(toggle).click();
            if (queryAll(selector).length) {
                return;
            }
        }
    }
}

test("[Offline] lead form DISABLE buttons unreachable and re-enabled online", async () => {
    const setOffline = mockOffline();
    stepRoutes((route) => !route.startsWith("/web/dataset/call_kw/"));
    const { env } = await makeMockServer();
    env["crm.lead"].write([1], {
        duplicate_lead_count: 2,
        is_blacklisted: true,
        phone_blacklisted: true,
        meeting_display_label: "No Meeting",
    });
    const rawLeadId = env["crm.lead"].create({ name: "Raw lead", type: "lead" });
    const lostLeadId = env["crm.lead"].create({
        name: "Lost lead",
        won_status: "lost",
        active: false,
        probability: 0,
    });
    let controller = null;
    patchWithCleanup(CrmFormController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    expect.verifySteps(["/web/action/load"]);

    /**
     * DISABLE controls of each lead state: `name`/`type` are the button's, `hotkey`
     * its `data-hotkey`, `selector` matches every rendering (wide and small layouts).
     */
    const cases = [
        {
            resId: 1,
            controls: [
                { selector: `button[name='${LOST_ACTION_ID}']`, name: `${LOST_ACTION_ID}`, type: "action", hotkey: "l" },
                { selector: "button[name=action_schedule_meeting]", name: "action_schedule_meeting" },
                { selector: "button[name=action_show_potential_duplicates]", name: "action_show_potential_duplicates" },
                { selector: "button[name=mail_action_blacklist_remove]", name: "mail_action_blacklist_remove" },
                { selector: "button[name=phone_action_blacklist_remove]", name: "phone_action_blacklist_remove" },
                { selector: "a[name=action_set_automated_probability]", name: "action_set_automated_probability", count: 2 },
            ],
        },
        {
            resId: rawLeadId,
            controls: [
                { selector: "button[name=action_convert_to_opportunity]", name: "action_convert_to_opportunity", hotkey: "v" },
                { selector: `button[name='${LOST_ACTION_ID}']`, name: `${LOST_ACTION_ID}`, type: "action", hotkey: "l" },
            ],
        },
        {
            resId: lostLeadId,
            controls: [
                { selector: "button[name=action_restore]", name: "action_restore", hotkey: "x" },
            ],
        },
    ];

    for (const { resId, controls } of cases) {
        await openLead(resId);
        // Reverse order: on the mobile preset, the header menu opened last stays
        // open when the connection drops (its toggle is disabled offline).
        for (const { selector, count = 1 } of [...controls].reverse()) {
            await revealFormControl(selector);
            expectUnguarded(selector, count);
        }

        await setOffline(true);
        const url = browser.location.href;
        for (const { selector, name, type = "object", hotkey, count = 1 } of controls) {
            await revealFormControl(selector);
            expectGuarded(selector, count);
            // Pointer, Enter and Space: nothing is issued, the URL does not change.
            await activateByPointerAndKeyboard(selector);
            if (hotkey) {
                await press(["alt", hotkey]);
                await animationFrame();
            }
            // Direct calls of the execution boundaries: the form controller refuses
            // the button, and the action service issues nothing.
            expect(await controller.beforeExecuteActionButton({ type, name })).toBe(false);
            await callButton({ resModel: "crm.lead", name, resId, type });
        }
        expect(browser.location.href).toBe(url);
        expect(".modal").toHaveCount(0);
        expect(queued("crm.lead")).toEqual([]);
        expect.verifySteps([]);

        // Online again: every control is enabled and issues its call.
        await setOffline(false);
        await animationFrame();
        for (const { selector, name, type = "object", count = 1 } of controls) {
            await revealFormControl(selector);
            expectUnguarded(selector, count);
            await contains(`${selector}:visible`).click();
            if (type === "action") {
                await expect.waitForSteps(["/web/action/load"]);
                expect(".modal .o_form_view").toHaveCount(1);
                await contains(".modal .o_form_button_cancel, .modal footer button[special=cancel]").click();
            } else {
                await expect.waitForSteps([buttonRoute("crm.lead", name), `${name} [${resId}]`]);
            }
        }
        await goBack();
    }

    // `action_set_won_rainbowman`, the Won button's own method. Offline the form
    // queues `action_set_won` in its place, so this method is reachable only through
    // a direct call of the button entry point, which issues nothing: no `call_button`,
    // no ORM call (the rainbowman lookup included), no queue entry, no won state.
    const wonButton = ".o_form_statusbar button[name=action_set_won_rainbowman]";
    await openLead(1);
    expect(wonButton).toHaveCount(1);
    const ormRoutes = stepRoutes((route) => route.startsWith("/web/dataset/call_kw/"));
    await setOffline(true);
    const formUrl = browser.location.href;
    await callButton({ resModel: "crm.lead", name: "action_set_won_rainbowman", resId: 1 });
    await animationFrame();
    expect.verifySteps([]);
    expect(queued("crm.lead")).toEqual([]);
    expect(browser.location.href).toBe(formUrl);
    expect(".modal").toHaveCount(0);
    expect(".o_reward").toHaveCount(0);
    expect(".ribbon:contains(Won)").toHaveCount(0);
    expect(wonButton).toHaveCount(1);
    expect(".o_field_widget[name=probability] input").toHaveValue("10.00");
    expect(env["crm.lead"].browse(1)[0]).toMatchObject({
        stage_id: STAGE_NEW,
        won_status: "pending",
        probability: 10,
    });
    ormRoutes.active = false;

    // Online again: the Won button issues it, and the form shows the won lead.
    await setOffline(false);
    await animationFrame();
    await contains(wonButton).click();
    await expect.waitForSteps([
        buttonRoute("crm.lead", "action_set_won_rainbowman"),
        "action_set_won_rainbowman [1]",
    ]);
    expect(env["crm.lead"].browse(1)[0]).toMatchObject({
        stage_id: STAGE_WON,
        won_status: "won",
        probability: 100,
    });
    await animationFrame();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(wonButton).toHaveCount(0);
    expect(".o_field_widget[name=probability]").toHaveText("100.00");
    expect(queued("crm.lead")).toEqual([]);
});

// Refine D2.6 (U6): guarded CRM view-button links keep no pointer events offline,
// although the framework's `.o_disabled_offline { pointer-events: auto !important }`
// applies to the whole page.

/** Pointer events a hover and a click dispatch to their target. */
const POINTER_EVENT_TYPES = ["pointerover", "pointerenter", "pointerdown", "pointerup", "click"];

/**
 * Hovers and clicks each displayed element matching `selector` as a pointer does, and
 * asserts that none of these events reaches it: an element out of hit-testing lets
 * them through to the element beneath.
 *
 * @param {string} selector
 */
async function expectPointerPassesThrough(selector) {
    const elements = queryAll(`${selector}:visible`);
    expect(elements.length).toBeGreaterThan(0);
    const received = [];
    const listener = (ev) => received.push(ev.type);
    for (const el of elements) {
        for (const type of POINTER_EVENT_TYPES) {
            el.addEventListener(type, listener);
        }
    }
    for (const el of elements) {
        await hover(el);
        await click(el);
    }
    await animationFrame();
    for (const el of elements) {
        for (const type of POINTER_EVENT_TYPES) {
            el.removeEventListener(type, listener);
        }
    }
    expect(received).toEqual([]);
}

/** Computed `pointer-events` of every element matching `selector`. */
function pointerEventsOf(selector) {
    return queryAll(selector).map((el) => getComputedStyle(el).pointerEvents);
}

/** View id of the partner form holding a link of another app (`PARTNER_LINK_FORM_ARCH`). */
const PARTNER_LINK_FORM_VIEW_ID = 509;

/**
 * Partner form with a view-button link of another app, carrying the two classes the
 * CRM guard sets (`o_disabled_offline pe-none`) but not its marker.
 */
const PARTNER_LINK_FORM_ARCH = /* xml */ `
    <form>
        <sheet>
            <a name="open_commercial_entity" type="object" class="o_disabled_offline pe-none">
                Commercial entity
            </a>
            <field name="name"/>
        </sheet>
    </form>`;

test("[Offline] guarded view-button links take no pointer events and regain them online", async () => {
    registerInlineViewArchs("res.partner", {
        [`form,${PARTNER_LINK_FORM_VIEW_ID}`]: PARTNER_LINK_FORM_ARCH,
    });
    const setOffline = mockOffline();
    stepRoutes((route) => route.startsWith("/web/dataset/call_button/"));
    const { env } = await makeMockServer();
    const partnerId = env["res.partner"].create({ name: "Azure Interior" });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();

    // Lead form: the AI-probability switch of a manually scored lead (wide and small
    // layouts).
    const aiSwitch = "a[name=action_set_automated_probability]";
    // A guarded `<button>` of the same form (in the header menu on the mobile preset).
    const meetingButton = "button[name=action_schedule_meeting]";
    await openLead(1);
    await revealFormControl(meetingButton);
    expectUnguarded(meetingButton, 1);
    expectUnguarded(aiSwitch, 2);
    const aiSwitchOnline = pointerEventsOf(aiSwitch);
    expect(aiSwitchOnline).toEqual(["auto", "auto"]);
    expect(`${aiSwitch}:interactive`).toHaveCount(2);

    await setOffline(true);
    expectGuarded(aiSwitch, 2);
    for (const link of queryAll(aiSwitch)) {
        // The framework's dimmed, not-allowed look is kept.
        expect(link).toHaveStyle({
            "pointer-events": "none",
            cursor: "not-allowed",
            opacity: "0.5",
        });
    }
    expect(`${aiSwitch}:interactive`).toHaveCount(0);
    // Every other control the framework disables keeps the framework's pointer events,
    // the guarded `<button>`s (disabled, so inert) included.
    expectGuarded(meetingButton, 1);
    expect(meetingButton).toHaveClass("o_crm_offline_guarded");
    const otherDisabled = ".o_disabled_offline:not(a.o_crm_offline_guarded)";
    expect(otherDisabled).not.toHaveCount(0);
    for (const value of pointerEventsOf(otherDisabled)) {
        expect(value).toBe("auto");
    }
    // Last: a click passing through closes the header menu of the mobile preset.
    await expectPointerPassesThrough(aiSwitch);
    expect.verifySteps([]);

    await setOffline(false);
    await animationFrame();
    expectUnguarded(aiSwitch, 2);
    expect(pointerEventsOf(aiSwitch)).toEqual(aiSwitchOnline);
    expect(`${aiSwitch}:interactive`).toHaveCount(2);
    expect(".o_crm_offline_guarded").toHaveCount(0);

    // Sales Teams dashboard: the card's "Unassigned Leads" link (`type="object"`) and
    // the `type="action"` links of a card menu opened online.
    await getService("action").doAction(TEAM_ACTION.id);
    await animationFrame();
    const unassigned = `${EUROPE_CARD} a[name=action_open_unassigned_opportunities]`;
    const menuLinks = ".o-dropdown--menu a[type=action]";
    await contains(EUROPE_MENU_TOGGLE, { visible: false }).click();
    expectUnguarded(unassigned, 1);
    expectUnguarded(menuLinks, 7);
    const teamLinksOnline = pointerEventsOf(`${unassigned}, ${menuLinks}`);
    expect(teamLinksOnline).toEqual(new Array(8).fill("auto"));

    await setOffline(true);
    expectGuarded(unassigned, 1);
    expectGuarded(menuLinks, 7);
    for (const link of queryAll(`${unassigned}, ${menuLinks}`)) {
        expect(link).toHaveStyle({ "pointer-events": "none", cursor: "not-allowed" });
    }
    expect(`${unassigned}:interactive, ${menuLinks}:interactive`).toHaveCount(0);
    // A click passing through a menu link lands in the menu, which closes it; one
    // passing through the card link lands on the card, which is inert offline.
    await expectPointerPassesThrough(`${menuLinks}:first`);
    await expectPointerPassesThrough(unassigned);
    await settle();
    expect(currentView()).toBe("sales_team.crm_team_action_pipeline/kanban");
    expect(queued("crm.team")).toEqual([]);
    expect.verifySteps([]);

    await setOffline(false);
    await animationFrame();
    if (!queryAll(menuLinks).length) {
        await contains(EUROPE_MENU_TOGGLE, { visible: false }).click();
    }
    expectUnguarded(unassigned, 1);
    expectUnguarded(menuLinks, 7);
    expect(pointerEventsOf(`${unassigned}, ${menuLinks}`)).toEqual(teamLinksOnline);
    expect(`${unassigned}:interactive, ${menuLinks}:interactive`).toHaveCount(8);
    await closeOpenDropdowns();

    // Another app's view-button link with the guard's classes but not its marker
    // keeps the framework's pointer events offline.
    const partnerLink = "a[name=open_commercial_entity]";
    await getService("action").doAction({
        type: "ir.actions.act_window",
        res_model: "res.partner",
        res_id: partnerId,
        views: [[PARTNER_LINK_FORM_VIEW_ID, "form"]],
    });
    await animationFrame();
    expect(partnerLink).toHaveCount(1);
    await setOffline(true);
    expect(partnerLink).toHaveClass(["o_disabled_offline", "pe-none"]);
    expect(partnerLink).not.toHaveClass("o_crm_offline_guarded");
    expect(partnerLink).toHaveStyle({ "pointer-events": "auto" });
    expect(`${partnerLink}:interactive`).toHaveCount(1);
    expect.verifySteps([]);
    await setOffline(false);
    await animationFrame();
});

/** Selects the first `count` list rows: checkboxes on desktop, long press on mobile. */
async function selectListRecords(count) {
    for (let index = 0; index < count; index++) {
        if (isSmall()) {
            const { drop } = await contains(`.o_data_row:eq(${index})`).drag();
            await drop();
        } else {
            await contains(`.o_data_row:eq(${index}) .o_list_record_selector input`).click();
        }
    }
}

/** Opens the Action menu (its toggle is available offline) unless it is open. */
async function openActionMenu() {
    if (!queryAll(".o-dropdown--menu .o_menu_item").length) {
        await toggleActionMenu();
    }
}

/** Action-menu items with this label (the open menu). */
function actionMenuItems(label) {
    return queryAll(".o-dropdown--menu .o_menu_item").filter(
        (item) => item.textContent.trim() === label
    );
}

/**
 * Asserts that the Action-menu items with these labels are dimmed offline and do
 * nothing when clicked or chosen with Enter or Space, then calls `onItemSelected` of
 * the menu component for each of its items not available offline.
 *
 * @param {string[]} labels
 * @param {() => import("@web/search/action_menus/action_menus").ActionMenus} getActionMenus
 */
async function expectInertActionMenuItems(labels, getActionMenus) {
    await openActionMenu();
    for (const label of labels) {
        expect(actionMenuItems(label).length).toBeGreaterThan(0);
        for (const item of actionMenuItems(label)) {
            expect(item).toHaveClass(["pe-none", "text-muted", "opacity-50"]);
        }
    }
    for (const label of labels) {
        for (let index = 0; index < actionMenuItems(label).length; index++) {
            await openActionMenu();
            await click(actionMenuItems(label)[index]);
            await animationFrame();
            await openActionMenu();
            const item = actionMenuItems(label)[index];
            item.focus();
            await press("Enter");
            await animationFrame();
            await openActionMenu();
            actionMenuItems(label)[index].focus();
            await press(" ");
            await animationFrame();
        }
    }
    const actionMenus = getActionMenus();
    const inertItems = actionMenus.actionItems.filter((item) => !item.availableOffline);
    const descriptions = inertItems.map((item) => String(item.description));
    for (const label of labels) {
        expect(descriptions).toInclude(label);
    }
    for (const item of inertItems) {
        await actionMenus.onItemSelected(item);
    }
    await animationFrame();
}

/** Closes the open wizard dialog with its footer Cancel/Discard button. */
async function cancelDialog() {
    await contains(".modal footer button[special=cancel], .modal .o_form_button_cancel").click();
}

// This test activates every wizard, mail and meeting entry point of the lead form and
// list offline, then opens each of their dialogs online. Under 3× CPU throttling on
// the mobile preset it lasts 4 to 4.4 s on an idle host, close to Hoot's 5 s default
// timeout, and 5.2 to 9 s on a loaded one (11 s on desktop), beyond it (a timed-out
// test keeps running into the next tests). Its own timeout replaces the runner's, so
// it stays above the 15 s the suite runners pass.
test.timeout(30_000);
test("[Offline] CRM wizards and bound actions unreachable", async () => {
    // Bound actions of `crm.lead` as `get_views` returns them (the mock server sends
    // one toolbar to every view type).
    CrmLead._toolbar = {
        action: [LOST_ACTION, MERGE_ACTION, MAIL_COMPOSE_ACTION, MASS_MAIL_ACTION, FOLLOWERS_ACTION],
        print: [],
    };
    // Every wizard, mail and meeting action of the lead views is a DISABLE action.
    const wizardActions = [
        LOST_ACTION,
        MASS_CONVERT_ACTION,
        MERGE_ACTION,
        PLS_UPDATE_ACTION,
        MAIL_COMPOSE_ACTION,
        MASS_MAIL_ACTION,
        FOLLOWERS_ACTION,
        MEETING_ACTION,
    ];
    for (const { xml_id } of wizardActions) {
        expect(CRM_OFFLINE_DISABLED_ACTIONS.has(xml_id)).toBe(true);
    }
    onRpc("/web/export/formats", () => [{ tag: "xlsx", label: "XLSX" }]);
    onRpc("/web/export/get_fields", () => []);
    onRpc("ir.exports", "search_read", () => []);
    let actionMenus = null;
    patchWithCleanup(ActionMenus.prototype, {
        setup() {
            super.setup(...arguments);
            actionMenus = this;
        },
    });
    const setOffline = mockOffline();
    stepRoutes(
        (route) =>
            route === "/web/action/load" ||
            route.startsWith("/web/dataset/call_button/") ||
            route.endsWith("/copy")
    );
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEADS_ACTION.id);
    await openLead(1);
    await flushStartupSync();
    expect.verifySteps(["/web/action/load"]);
    const activeContext = { active_id: 1, active_ids: [1, 2], active_model: "crm.lead" };

    // Lead form, offline: Mark Lost, Send email, Duplicate and Edit Properties.
    await setOffline(true);
    const formItems = ["Mark Lost", "Send email", "Duplicate", "Edit Properties"];
    await expectInertActionMenuItems(formItems, () => actionMenus);
    // Direct opening of every wizard, mail and meeting action by `xml_id`.
    for (const { xml_id } of wizardActions) {
        await getService("action").doAction(xml_id, { additionalContext: activeContext });
    }
    await animationFrame();
    expect(".modal").toHaveCount(0);
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Lead 1");
    expect(queued("crm.lead")).toEqual([]);
    expect.verifySteps([]);

    // Lead list, offline: the bound actions of a selection, the header mass actions
    // and the row Email button.
    await setOffline(false);
    await animationFrame();
    await goBack();
    await selectListRecords(2);
    await setOffline(true);
    const listItems = ["Export", "Duplicate", "Mark Lost", "Merge", "Send email", "Add/Remove Followers"];
    await expectInertActionMenuItems(listItems, () => actionMenus);
    if (queryAll(".o-dropdown--menu .o_menu_item").length) {
        await toggleActionMenu();
    }
    // The header buttons: beside the selection on desktop, in the selection's
    // Action menu on the mobile preset.
    const headerButtons = [
        `button[name='${MASS_CONVERT_ACTION_ID}']`,
        `button[name='${LOST_ACTION_ID}']`,
        `button[name='${MASS_MAIL_ACTION_ID}']`,
    ];
    if (isSmall()) {
        await openActionMenu();
    }
    for (const selector of headerButtons) {
        expect(selector).toHaveCount(1);
        expect(selector).not.toBeEnabled();
        await activateByPointerAndKeyboard(selector);
    }
    if (queryAll(".o-dropdown--menu .o_menu_item").length) {
        await toggleActionMenu();
    }
    expectGuarded(
        `.o_data_row button[name='${MAIL_COMPOSE_ACTION_ID}']`,
        queryAll(".o_data_row").length
    );
    await activateByPointerAndKeyboard(`.o_data_row button[name='${MAIL_COMPOSE_ACTION_ID}']`);
    for (const name of [MASS_CONVERT_ACTION_ID, LOST_ACTION_ID, MASS_MAIL_ACTION_ID, MAIL_COMPOSE_ACTION_ID]) {
        await getService("action").doActionButton({
            type: "action",
            name: `${name}`,
            resModel: "crm.lead",
            resIds: [1, 2],
            context: {},
            buttonContext: {},
        });
    }
    await animationFrame();
    expect(".modal").toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
    expect.verifySteps([]);

    // Online, each control opens its wizard (or runs) again.
    await setOffline(false);
    await animationFrame();
    for (const label of ["Mark Lost", "Merge", "Add/Remove Followers", "Send email"]) {
        // The list reloads, and clears its selection, after each executed action.
        if (!queryAll(".o_data_row_selected").length) {
            await selectListRecords(2);
        }
        await openActionMenu();
        expect(actionMenuItems(label).length).toBeGreaterThan(0, { message: label });
        const [item] = actionMenuItems(label);
        expect(item).not.toHaveClass("pe-none");
        await contains(item).click();
        await expect.waitForSteps(["/web/action/load"]);
        expect(".modal").toHaveCount(1);
        await cancelDialog();
    }
    if (!queryAll(".o_data_row_selected").length) {
        await selectListRecords(2);
    }
    await openActionMenu();
    await contains(actionMenuItems("Export")[0]).click();
    expect(".modal .o_export_data_dialog").toHaveCount(1);
    await contains(".modal .o_export_data_dialog .o_form_button_cancel").click();
    // The header mass actions: Convert to Opportunities, Mark Lost and Email (mass mail).
    for (const name of [MASS_CONVERT_ACTION_ID, LOST_ACTION_ID, MASS_MAIL_ACTION_ID]) {
        if (!queryAll(".o_data_row_selected").length) {
            await selectListRecords(2);
        }
        if (isSmall()) {
            await openActionMenu();
        }
        await contains(`button[name='${name}']:visible`).click();
        await expect.waitForSteps(["/web/action/load"]);
        expect(".modal .o_form_view").toHaveCount(1);
        await cancelDialog();
    }
    // The row Email button opens the mail composer of its lead.
    for (const button of queryAll(`.o_data_row button[name='${MAIL_COMPOSE_ACTION_ID}']`)) {
        expect(button).toBeEnabled();
        expect(button).not.toHaveClass("o_disabled_offline");
        expect(button).not.toHaveAttribute("aria-disabled");
    }
    await contains(`.o_data_row:eq(0) button[name='${MAIL_COMPOSE_ACTION_ID}']:visible`).click();
    await expect.waitForSteps(["/web/action/load"]);
    expect(".modal .o_form_view .o_field_widget[name=body]").toHaveCount(1);
    await cancelDialog();
    if (!queryAll(".o_data_row_selected").length) {
        await selectListRecords(2);
    }
    await openActionMenu();
    await contains(actionMenuItems("Duplicate")[0]).click();
    // Duplicating several records asks for a confirmation.
    await contains(".modal-footer .btn-primary").click();
    await expect.waitForSteps(["/web/dataset/call_kw/crm.lead/copy"]);

    // Online lead form: its items work again, and the PLS update wizard opens.
    await openLead(1);
    await openActionMenu();
    await contains(actionMenuItems("Mark Lost")[0]).click();
    await expect.waitForSteps(["/web/action/load"]);
    expect(".modal .o_form_view").toHaveCount(1);
    await cancelDialog();
    await getService("action").doAction(PLS_UPDATE_ACTION.xml_id);
    await expect.waitForSteps(["/web/action/load"]);
    expect(".modal .o_form_view").toHaveCount(1);
    await cancelDialog();
    // Duplicate copies the lead on the server.
    const leadCopies = () => MockServer.env["crm.lead"].search_count([["name", "=", "Lead 1"]]);
    const copiesBefore = leadCopies();
    await openActionMenu();
    expect(actionMenuItems("Duplicate")[0]).not.toHaveClass("pe-none");
    await contains(actionMenuItems("Duplicate")[0]).click();
    await expect.waitForSteps(["/web/dataset/call_kw/crm.lead/copy"]);
    expect(leadCopies()).toBe(copiesBefore + 1);
    await openActionMenu();
    await contains(actionMenuItems("Edit Properties")[0]).click();
    await openActionMenu();
    expect(actionMenuItems("Save Properties")).toHaveLength(1);
});

test("[Offline] wizard opened online cannot be applied", async () => {
    const setOffline = mockOffline();
    stepRoutes((route) => route.startsWith("/web/dataset/call_button/"));
    // The wizards' `web_save` requests, stepped while offline and on the reconnection:
    // a transient record is neither saved nor queued offline, so none is replayed.
    const transientSaves = stepRoutes((route) => route.endsWith("/web_save"));
    transientSaves.active = false;
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    const activeContext = { active_id: 1, active_ids: [1, 2], active_model: "crm.lead" };

    /** The four CRM wizards, a value entered online in each, and its apply method. */
    const wizards = [
        {
            action: LOST_ACTION,
            model: "crm.lead.lost",
            method: "action_lost_reason_apply",
            enter: () =>
                contains(".modal .o_field_widget[name=lost_feedback] input").edit("Too pricey", {
                    confirm: "blur",
                }),
            expectEntered: () => {
                expect(".modal .o_field_widget[name=lost_feedback] input").toHaveValue("Too pricey");
            },
            saved: { lost_feedback: "Too pricey" },
        },
        {
            action: MASS_CONVERT_ACTION,
            model: "crm.lead2opportunity.partner.mass",
            method: "action_apply",
            enter: () => contains(".modal .o_field_widget[name=name] input[data-value=merge]").click(),
            expectEntered: () => {
                expect(".modal .o_field_widget[name=name] input[data-value=merge]").toBeChecked();
            },
            saved: { name: "merge" },
        },
        {
            action: MERGE_ACTION,
            model: "crm.merge.opportunity",
            method: "action_merge",
            // The wizard is filled with the selected leads.
            enter: async () => {},
            expectEntered: () => {
                expect(".modal .o_field_widget[name=opportunity_ids] .o_data_row").toHaveCount(2);
            },
            saved: { opportunity_ids: [1, 2] },
        },
        {
            action: PLS_UPDATE_ACTION,
            model: "crm.lead.pls.update",
            method: "action_update_crm_lead_probabilities",
            enter: () =>
                contains(".modal .o_field_widget[name=pls_start_date] input").edit("2026-01-01", {
                    confirm: "blur",
                }),
            expectEntered: () => {
                expect(".modal .o_field_widget[name=pls_start_date] input").toHaveValue("2026-01-01");
            },
            saved: { pls_start_date: "2026-01-01" },
        },
    ];

    for (const { action, model, method, enter, expectEntered, saved } of wizards) {
        // Opened and filled online, then the connection drops.
        await getService("action").doAction(action.id, { additionalContext: activeContext });
        expect(".modal .o_form_view").toHaveCount(1);
        await enter();
        await setOffline(true);
        transientSaves.active = true;

        // The apply button is disabled and inert; a direct call issues nothing.
        const apply = `.modal footer button[name=${method}]`;
        expect(apply).toHaveCount(1);
        expect(apply).not.toBeEnabled();
        await activateByPointerAndKeyboard(apply);
        // Its Alt+Q hotkey (`data-hotkey="q"`) clicks nothing: the button is disabled.
        await press(["alt", "q"]);
        await settle();
        await getService("action").doActionButton({
            type: "object",
            name: method,
            resModel: model,
            resIds: [],
            context: {},
            buttonContext: {},
        });
        await animationFrame();
        // The wizard stays, with what was entered.
        expect(".modal .o_form_view").toHaveCount(1);
        expectEntered();
        expect(queued(model)).toEqual([]);
        expect.verifySteps([]);
        // A forced activation of the disabled button stops before the wizard's record
        // is saved: no `web_save` is attempted or queued.
        forceClick(apply);
        await settle();
        expect(".modal .o_form_view").toHaveCount(1);
        expectEntered();
        expect(queued(model)).toEqual([]);
        expect.verifySteps([]);

        // Back online, nothing is replayed, and it applies.
        await reconnect(setOffline);
        expect(queued(model)).toEqual([]);
        expect.verifySteps([]);
        transientSaves.active = false;
        expect(apply).toBeEnabled();
        await contains(apply).click();
        await expect.waitForSteps([buttonRoute(model, method), `${method} [1]`]);
        expect(".modal").toHaveCount(0);
        expect(MockServer.env[model].browse(1)[0]).toMatchObject(saved);

        // Cancelling still closes a wizard opened online. The footer Cancel <button>
        // is disabled offline by the framework, like every footer button lacking
        // `data-available-offline`; the dialog's own close control is available
        // offline, and the `special` cancel call is left to the framework by the
        // CRM button guard.
        await getService("action").doAction(action.id, { additionalContext: activeContext });
        await setOffline(true);
        expect(".modal footer button[special=cancel]").not.toBeEnabled();
        // Its pointer, keyboard and Alt+X hotkey activations do nothing.
        await activateByPointerAndKeyboard(".modal footer button[special=cancel]");
        await press(["alt", "x"]);
        await animationFrame();
        expect(".modal .o_form_view").toHaveCount(1);
        await getService("action").doActionButton({
            special: "cancel",
            resModel: model,
            resIds: [],
            context: {},
            buttonContext: {},
        });
        await animationFrame();
        expect(".modal").toHaveCount(0);
        await setOffline(false);
        await getService("action").doAction(action.id, { additionalContext: activeContext });
        await setOffline(true);
        await contains(".modal button[aria-label=Close]:visible").click();
        expect(".modal").toHaveCount(0);
        await setOffline(false);
        await animationFrame();
        expect(queued(model)).toEqual([]);
        expect.verifySteps([]);

        // Online again, the footer Cancel is enabled and closes the wizard, with no
        // server call.
        await getService("action").doAction(action.id, { additionalContext: activeContext });
        expect(".modal .o_form_view").toHaveCount(1);
        expect(".modal footer button[special=cancel]").toBeEnabled();
        await contains(".modal footer button[special=cancel]").click();
        expect(".modal").toHaveCount(0);
        expect(queued(model)).toEqual([]);
        expect.verifySteps([]);

        // Online, the Alt+Q hotkey applies the wizard (its second record).
        await getService("action").doAction(action.id, { additionalContext: activeContext });
        expect(".modal .o_form_view").toHaveCount(1);
        await press(["alt", "q"]);
        await settle();
        await expect.waitForSteps([buttonRoute(model, method), `${method} [2]`]);
        expect(".modal").toHaveCount(0);
        expect(queued(model)).toEqual([]);
    }
});

/** Forecast (`crm.crm_lead_action_forecast`): forecast kanban and list, graph and pivot. */
const FORECAST_ACTION = {
    id: 30,
    xml_id: "crm.crm_lead_action_forecast",
    name: "Forecast",
    res_model: "crm.lead",
    views: [
        [FORECAST_KANBAN_VIEW_ID, "kanban"],
        [false, "graph"],
        [false, "pivot"],
        [FORECAST_LIST_VIEW_ID, "list"],
        [false, "form"],
    ],
    domain: [["type", "=", "opportunity"]],
    context: { default_type: "opportunity", forecast_field: "date_deadline" },
};

/** Reporting > Pipeline (`crm.crm_opportunity_report_action`). */
const OPPORTUNITY_REPORT_ACTION = {
    id: 31,
    xml_id: "crm.crm_opportunity_report_action",
    name: "Pipeline Analysis",
    res_model: "crm.lead",
    views: [
        [false, "graph"],
        [false, "pivot"],
        [false, "list"],
    ],
};

/** Reporting > Leads (`crm.crm_opportunity_report_action_lead`). */
const LEAD_REPORT_ACTION = {
    id: 32,
    xml_id: "crm.crm_opportunity_report_action_lead",
    name: "Leads Analysis",
    res_model: "crm.lead",
    views: [
        [false, "graph"],
        [false, "pivot"],
        [false, "list"],
    ],
};

/** Reporting > Activities (`crm.crm_activity_report_action`). */
const ACTIVITY_REPORT_ACTION = {
    id: 33,
    xml_id: "crm.crm_activity_report_action",
    name: "Activities",
    res_model: "crm.activity.report",
    views: [
        [false, "graph"],
        [false, "pivot"],
        [false, "list"],
    ],
};

/** Team activity analysis, from a dashboard card (`crm.crm_activity_report_action_team`). */
const ACTIVITY_REPORT_TEAM_ACTION = {
    id: ACTIVITY_REPORT_TEAM_ACTION_ID,
    xml_id: "crm.crm_activity_report_action_team",
    name: "Pipeline Activities",
    res_model: "crm.activity.report",
    views: [
        [false, "graph"],
        [false, "pivot"],
        [false, "list"],
    ],
};

/** Team leads analysis, from a dashboard card (`crm.action_report_crm_lead_salesteam`). */
const LEAD_SALESTEAM_REPORT_ACTION = {
    id: LEAD_SALESTEAM_REPORT_ACTION_ID,
    xml_id: "crm.action_report_crm_lead_salesteam",
    name: "Leads Analysis",
    res_model: "crm.lead",
    views: [
        [false, "graph"],
        [false, "pivot"],
        [false, "list"],
    ],
};

/** CRM settings (`crm.crm_config_settings_action`). */
const SETTINGS_ACTION = {
    id: 36,
    xml_id: "crm.crm_config_settings_action",
    name: "Settings",
    res_model: "res.config.settings",
    views: [[false, "form"]],
    context: { module: "crm", bin_size: false },
};

/** Configuration > Recurring Plans (`crm.crm_recurring_plan_action`). */
const RECURRING_PLAN_ACTION = {
    id: 37,
    xml_id: "crm.crm_recurring_plan_action",
    name: "Recurring Plans",
    res_model: "crm.recurring.plan",
    views: [[false, "list"]],
};

/** My Activities (`crm.crm_lead_action_my_activities`), with every lead view type. */
const MY_ACTIVITIES_ACTION = {
    id: 38,
    xml_id: "crm.crm_lead_action_my_activities",
    name: "My Activities",
    res_model: "crm.lead",
    views: [
        [false, "list"],
        [false, "kanban"],
        [false, "graph"],
        [false, "pivot"],
        [false, "calendar"],
        [false, "form"],
        [false, "activity"],
    ],
};

/**
 * A lead pivot report without a CRM `xml_id` (e.g. created by a user): the action
 * guard cannot identify it, so only the view-mount backstop keeps it closed offline.
 */
const CUSTOM_REPORT_ACTION = {
    id: 39,
    name: "Revenue by stage",
    res_model: "crm.lead",
    views: [[false, "pivot"]],
};

/**
 * Another lead report without a CRM `xml_id`, on its own graph view: its action
 * alone is loaded online, so its view and data are still to load when it is
 * opened offline by its numeric id.
 */
const COLD_REPORT_ACTION = {
    id: 45,
    name: "Revenue by team",
    res_model: "crm.lead",
    views: [[COLD_REPORT_GRAPH_VIEW_ID, "graph"]],
};

defineActions([
    FORECAST_ACTION,
    OPPORTUNITY_REPORT_ACTION,
    LEAD_REPORT_ACTION,
    ACTIVITY_REPORT_ACTION,
    ACTIVITY_REPORT_TEAM_ACTION,
    LEAD_SALESTEAM_REPORT_ACTION,
    SETTINGS_ACTION,
    RECURRING_PLAN_ACTION,
    MY_ACTIVITIES_ACTION,
    CUSTOM_REPORT_ACTION,
    COLD_REPORT_ACTION,
]);

/** CRM navbar (`crm_menu_views.xml`): the pipeline, Reporting and Configuration. */
const CRM_MENUS = [
    {
        id: 1,
        name: "CRM",
        xmlid: "crm.crm_menu_root",
        actionID: PIPELINE_ACTION.id,
        appID: 1,
        children: [
            { id: 2, name: "Sales", xmlid: "crm.crm_menu_sales", actionID: PIPELINE_ACTION.id, appID: 1 },
            {
                id: 3,
                name: "Reporting",
                xmlid: "crm.crm_menu_report",
                appID: 1,
                children: [
                    { id: 4, name: "Forecast", xmlid: "crm.crm_menu_forecast", actionID: FORECAST_ACTION.id, appID: 1 },
                    { id: 5, name: "Pipeline", xmlid: "crm.crm_opportunity_report_menu", actionID: OPPORTUNITY_REPORT_ACTION.id, appID: 1 },
                    { id: 6, name: "Leads", xmlid: "crm.crm_opportunity_report_menu_lead", actionID: LEAD_REPORT_ACTION.id, appID: 1 },
                    { id: 7, name: "Activities", xmlid: "crm.crm_activity_report_menu", actionID: ACTIVITY_REPORT_ACTION.id, appID: 1 },
                ],
            },
            {
                id: 8,
                name: "Configuration",
                xmlid: "crm.crm_menu_config",
                appID: 1,
                children: [
                    { id: 9, name: "Settings", xmlid: "crm.crm_config_settings_menu", actionID: SETTINGS_ACTION.id, appID: 1 },
                    { id: 10, name: "Recurring Plans", xmlid: "crm.crm_recurring_plan_menu_config", actionID: RECURRING_PLAN_ACTION.id, appID: 1 },
                ],
            },
        ],
    },
];

/** Menus of `CRM_MENUS` opening a CRM DISABLE action, with their navbar section. */
const DISABLED_MENUS = [
    { id: 4, xmlid: "crm.crm_menu_forecast", section: "Reporting", view: `${FORECAST_ACTION.xml_id}/kanban` },
    { id: 5, xmlid: "crm.crm_opportunity_report_menu", section: "Reporting", view: `${OPPORTUNITY_REPORT_ACTION.xml_id}/graph` },
    { id: 6, xmlid: "crm.crm_opportunity_report_menu_lead", section: "Reporting", view: `${LEAD_REPORT_ACTION.xml_id}/graph` },
    { id: 7, xmlid: "crm.crm_activity_report_menu", section: "Reporting", view: `${ACTIVITY_REPORT_ACTION.xml_id}/graph` },
    { id: 9, xmlid: "crm.crm_config_settings_menu", section: "Configuration", view: `${SETTINGS_ACTION.xml_id}/form` },
    { id: 10, xmlid: "crm.crm_recurring_plan_menu_config", section: "Configuration", view: `${RECURRING_PLAN_ACTION.xml_id}/list` },
];

/**
 * Opens the navbar section dropdown holding a menu entry (the section toggles are
 * available offline) and returns the entry's selector.
 */
async function openNavbarEntry(section, xmlid) {
    const entry = `.o-dropdown--menu .dropdown-item[data-menu-xmlid='${xmlid}']`;
    if (!queryAll(entry).length) {
        await contains(`.o_menu_sections button:contains(${section})`).click();
    }
    return entry;
}

/** The controller the web client displays: its action `xml_id` and view type. */
function currentView() {
    const controller = getService("action").currentController;
    if (!controller) {
        return null;
    }
    const { action, view } = controller;
    return `${action.xml_id || action.id}/${view.type}`;
}

/** Waits for the web client to display `view` (a navigation resolves asynchronously). */
async function expectCurrentView(view) {
    await waitUntil(() => currentView() === view, { timeout: 1000 }).catch(() => {});
    expect(currentView()).toBe(view);
}

/** Lets any navigation an inert control could have started run to its end. */
async function settle() {
    await runAllTimers();
    await animationFrame();
}

test.tags("desktop");
// This test drives every blocked view through each offline path, and each offline
// settling runs the offline plugin's next, exponentially delayed, connection check,
// so it lasts about 5.5 s, above Hoot's 5 s default timeout (a timed-out test keeps
// running into the next tests). Its own timeout replaces the runner's, so it stays
// above the 15 s the suite runners pass.
test.timeout(30_000);
test("[Offline] forecast, reports and analysis views unreachable after an online visit", async () => {
    // Offline root load served from the cache: the list of My Activities.
    expect.errors(1);
    defineMenus(CRM_MENUS);
    for (const { xmlid } of DISABLED_MENUS) {
        expect(CRM_OFFLINE_DISABLED_MENUS.has(xmlid)).toBe(true);
    }
    const setOffline = mockOffline();
    const stepping = stepRoutes(
        (route) =>
            route === "/web/action/load" ||
            route.includes("/crm.lead/") ||
            route.includes("/crm.activity.report/")
    );
    stepping.active = false;
    await mountWithCleanup(WebClient);
    await getService("menu").selectMenu(2);
    expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");

    // Online visit of every target: the navbar entries (forecast, reports,
    // settings, recurring plans), the forecast list, the team analysis actions,
    // the lead graph and pivot views, and a custom lead report (its action and
    // view).
    for (const { section, xmlid, view } of DISABLED_MENUS) {
        await contains(await openNavbarEntry(section, xmlid)).click();
        await expectCurrentView(view);
    }
    await getService("menu").selectMenu(4);
    await getService("action").switchView("list");
    expect(currentView()).toBe("crm.crm_lead_action_forecast/list");
    // A lead form opened from the forecast, and the pipeline report's list: each
    // marks a view of its action visited, which alone would leave its navbar entry
    // enabled offline.
    await contains(".o_data_row:contains(Lead 1) .o_data_cell:eq(0)").click();
    await expectCurrentView("crm.crm_lead_action_forecast/form");
    await getService("menu").selectMenu(5);
    await getService("action").switchView("list");
    expect(currentView()).toBe("crm.crm_opportunity_report_action/list");
    /** Actions opened online, with the context they were opened with. */
    const visits = [
        { action: FORECAST_ACTION },
        { action: OPPORTUNITY_REPORT_ACTION },
        { action: LEAD_REPORT_ACTION },
        { action: ACTIVITY_REPORT_ACTION },
        { action: ACTIVITY_REPORT_TEAM_ACTION, context: { active_id: 1 } },
        { action: LEAD_SALESTEAM_REPORT_ACTION, context: { active_id: 1 } },
        { action: TEAM_REPORT_ACTION },
        { action: SETTINGS_ACTION },
        { action: RECURRING_PLAN_ACTION },
    ];
    for (const { action, context } of visits.filter(({ context }) => context)) {
        await getService("action").doAction(action.id, { additionalContext: context });
        expect(currentView()).toBe(`${action.xml_id}/graph`);
    }
    await getService("action").doAction(TEAM_REPORT_ACTION.id);
    expect(".o_pivot_view").toHaveCount(1);
    await getService("action").doAction(MY_ACTIVITIES_ACTION.id);
    for (const viewType of ["graph", "pivot", "list"]) {
        await getService("action").switchView(viewType);
        expect(currentView()).toBe(`crm.crm_lead_action_my_activities/${viewType}`);
    }
    await getService("action").doAction(CUSTOM_REPORT_ACTION.id);
    expect(".o_pivot_view").toHaveCount(1);
    // The other custom lead report: its action is loaded (and cached), its view is
    // never opened.
    stepping.active = true;
    await getService("action").loadAction(COLD_REPORT_ACTION.id);
    expect.verifySteps(["/web/action/load"]);
    stepping.active = false;
    await getService("menu").selectMenu(2);
    expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    await flushStartupSync();

    await setOffline(true);
    stepping.active = true;
    // The forecast views are never marked available, even after a visit...
    const offlinePlugin = getService(OfflinePlugin);
    expect(offlinePlugin.isAvailableOffline(FORECAST_ACTION.id, "kanban")).toBe(false);
    expect(offlinePlugin.isAvailableOffline(FORECAST_ACTION.id, "list")).toBe(false);
    // ... but the visited registry holds the forecast through its lead form, the
    // pipeline report through its list, and the recurring plans through theirs.
    expect(offlinePlugin.isAvailableOffline(FORECAST_ACTION.id)).toBe(true);
    expect(offlinePlugin.isAvailableOffline(OPPORTUNITY_REPORT_ACTION.id, "list")).toBe(true);
    expect(offlinePlugin.isAvailableOffline(RECURRING_PLAN_ACTION.id, "list")).toBe(true);

    // Navbar: every entry is dimmed whatever view of its action was visited, and is
    // inert by click, Enter, Space and a direct `selectMenu` (id or menu). The
    // visited pipeline entry keeps the framework's state.
    expect(".o_menu_sections .o_nav_entry[data-menu-xmlid='crm.crm_menu_sales']").not.toHaveClass(
        "o_disabled_offline"
    );
    for (const { id, section, xmlid } of DISABLED_MENUS) {
        const entry = await openNavbarEntry(section, xmlid);
        expect(entry).toHaveClass("o_disabled_offline");
        await click(queryFirst(entry));
        await settle();
        expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
        const entryEl = queryFirst(await openNavbarEntry(section, xmlid));
        entryEl.focus();
        await press("Enter");
        await animationFrame();
        // Space on the entry of the section menu, opened again if needed (Escape then
        // closes it). Enter and Space share one settling: each offline settling runs
        // the next, exponentially delayed, connection check of the offline plugin.
        queryFirst(await openNavbarEntry(section, xmlid)).focus();
        await press(" ");
        await settle();
        expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
        await press("Escape");
        await animationFrame();
        await getService("menu").selectMenu(id);
        await getService("menu").selectMenu(getService("menu").getMenu(id));
        await settle();
        expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    }
    expect(Object.keys(offlinePlugin._ormToSync())).toEqual([]);
    // Direct `doAction` by `xml_id` and by numeric id (identified, with no request,
    // from the web client's own online load of that action).
    for (const { action, context } of visits) {
        expect(CRM_OFFLINE_DISABLED_ACTIONS.has(action.xml_id)).toBe(true);
        await getService("action").doAction(action.xml_id, { additionalContext: context });
        await getService("action").doAction(action.id, { additionalContext: context });
        await settle();
        expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    }
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
    expect(Object.keys(offlinePlugin._ormToSync())).toEqual([]);

    // View switches of a lead action: the graph, pivot, calendar and activity
    // switchers are dimmed and inert by click and keyboard (a disabled button takes
    // no focus, so Enter and Space cannot reach it), and a direct `switchView`
    // keeps the list.
    await getService("action").doAction(MY_ACTIVITIES_ACTION.id);
    expect(currentView()).toBe("crm.crm_lead_action_my_activities/list");
    expect.verifySteps(["/web/dataset/call_kw/crm.lead/web_search_read"]);
    for (const viewType of ["graph", "pivot", "calendar", "activity"]) {
        const switcher = `.o_cp_switch_buttons .o_switch_view.o_${viewType}`;
        expect(switcher).not.toHaveAttribute("data-available-offline");
        expect(switcher).not.toBeEnabled();
        queryFirst(switcher).focus();
        expect(document.activeElement).not.toBe(queryFirst(switcher));
        await activateByPointerAndKeyboard(switcher);
        await getService("action").switchView(viewType);
        await settle();
        expect(currentView()).toBe("crm.crm_lead_action_my_activities/list");
    }
    expect.verifySteps([]);
    expect(Object.keys(offlinePlugin._ormToSync())).toEqual([]);

    // A lead report the action guard cannot identify (no CRM `xml_id`), whose
    // action and view were loaded online, mounts the offline helper, with no view
    // or data request...
    await getService("action").doAction(CUSTOM_REPORT_ACTION.id);
    expect(".o_pivot_view").toHaveCount(0);
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    expect.verifySteps([]);
    // ... and loads its data once the connection is back (its view is cached).
    await setOffline(false);
    await animationFrame();
    expect(".o_pivot_view").toHaveCount(1);
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(0);
    expect.verifySteps(["/web/dataset/call_kw/crm.lead/formatted_read_grouping_sets"]);

    // The report whose action alone was loaded online, opened offline by its
    // numeric id, is not identified either: the original `doAction` opens it from
    // the cached action, and the view-mount backstop renders the helper before any
    // view or data request...
    await setOffline(true);
    await getService("action").doAction(COLD_REPORT_ACTION.id);
    await animationFrame();
    expect(currentView()).toBe(`${COLD_REPORT_ACTION.id}/graph`);
    expect(".o_graph_view").toHaveCount(0);
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    expect.verifySteps([]);
    // ... then, once the connection is back, loads its view and its data, once.
    await setOffline(false);
    await animationFrame();
    expect(".o_action_manager .o_view_controller.o_graph_view").toHaveCount(1);
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(0);
    expect.verifySteps([
        "/web/dataset/call_kw/crm.lead/get_views",
        "/web/dataset/call_kw/crm.lead/formatted_read_group",
    ]);
    stepping.active = false;

    // A report view mounted when the connection drops swaps to the helper, and back.
    await getService("action").doAction(TEAM_REPORT_ACTION.id);
    expect(".o_pivot_view").toHaveCount(1);
    await setOffline(true);
    expect(".o_pivot_view").toHaveCount(0);
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    await setOffline(false);
    await animationFrame();
    expect(".o_pivot_view").toHaveCount(1);
    // So is the activity analysis list, whose rows open their lead through the
    // server (`action_open_lead`): no row can be opened offline.
    await getService("action").doAction(ACTIVITY_REPORT_ACTION.id);
    await getService("action").switchView("list");
    await animationFrame();
    expect(".o_list_view .o_data_row").toHaveCount(1);
    await setOffline(true);
    expect(".o_data_row").toHaveCount(0);
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    // A direct call of the row action issues no `call_button` either.
    stepping.active = true;
    await getService("action").doActionButton({
        type: "object",
        name: "action_open_lead",
        resModel: "crm.activity.report",
        resId: 1,
        resIds: [1],
        context: {},
        buttonContext: {},
    });
    await settle();
    expect.verifySteps([]);
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    expect(currentView()).toBe("crm.crm_activity_report_action/list");
    stepping.active = false;
    await setOffline(false);
    await animationFrame();
    await contains(".o_data_row .o_data_cell:eq(0)").click();
    await expect.waitForSteps(["action_open_lead [1]"]);

    // Online, every entry opens its view again...
    for (const { section, xmlid, view } of DISABLED_MENUS) {
        const entry = await openNavbarEntry(section, xmlid);
        expect(entry).not.toHaveClass("o_disabled_offline");
        await contains(entry).click();
        await expectCurrentView(view);
    }
    // ... and so does each view switcher of a lead action.
    await getService("action").doAction(MY_ACTIVITIES_ACTION.id);
    await expectCurrentView("crm.crm_lead_action_my_activities/list");
    for (const viewType of ["graph", "pivot", "calendar", "activity"]) {
        const switcher = `.o_cp_switch_buttons .o_switch_view.o_${viewType}`;
        expect(switcher).toBeEnabled();
        await contains(switcher).click();
        await expectCurrentView(`crm.crm_lead_action_my_activities/${viewType}`);
        expect(`.o_action_manager .o_view_controller.o_${viewType}_view`).toHaveCount(1);
    }
    expect.verifyErrors([LEAD_LIST_LOAD]);
});

// Refine D2.4/D2.5 (U4, U5)

/**
 * Another app, beside `CRM_MENUS`: its Stages entry opens a visited action, its
 * Teams entry an action never opened, which the framework dims offline.
 */
const OTHER_APP_MENU = {
    id: 20,
    name: "Other app",
    xmlid: "test.other_menu_root",
    actionID: STAGE_ACTION.id,
    appID: 20,
    children: [
        { id: 21, name: "Stages", xmlid: "test.other_menu_stages", actionID: STAGE_ACTION.id, appID: 20 },
        { id: 22, name: "Teams", xmlid: "test.other_menu_teams", actionID: TEAM_ACTION.id, appID: 20 },
    ],
};

const PIPELINE_VIEW = "crm.crm_lead_action_pipeline/kanban";

/**
 * `openNavbarEntry`, closing first another open section dropdown (Escape), and
 * waiting for the entry to render.
 */
async function openNavbarEntryRendered(section, xmlid) {
    const entry = `.o-dropdown--menu .dropdown-item[data-menu-xmlid='${xmlid}']`;
    if (!queryAll(entry).length && queryAll(".o-dropdown--menu").length) {
        await press("Escape");
        await animationFrame();
    }
    await openNavbarEntry(section, xmlid);
    await waitFor(entry);
    return entry;
}

/** Opens every `DISABLED_MENUS` entry online, then comes back to the pipeline. */
async function visitDisabledMenus() {
    await getService("menu").selectMenu(2);
    expect(currentView()).toBe(PIPELINE_VIEW);
    for (const { id, view } of DISABLED_MENUS) {
        await getService("menu").selectMenu(id);
        await expectCurrentView(view);
    }
    await getService("menu").selectMenu(2);
    expect(currentView()).toBe(PIPELINE_VIEW);
    await flushStartupSync();
}

test.tags("desktop");
test("[Offline] desktop navbar entries of blocked CRM menus are aria-disabled and inert", async () => {
    defineMenus([...CRM_MENUS, OTHER_APP_MENU]);
    const setOffline = mockOffline();
    const stepping = stepRoutes();
    stepping.active = false;
    await mountWithCleanup(WebClient);
    // The visited registry then holds every blocked action.
    await visitDisabledMenus();
    const pipelineEntry = ".o_menu_sections .o_nav_entry[data-menu-xmlid='crm.crm_menu_sales']";

    // Online, the entries carry the framework's attributes only.
    for (const { section, xmlid } of DISABLED_MENUS) {
        const entry = await openNavbarEntryRendered(section, xmlid);
        expect(entry).not.toHaveAttribute("aria-disabled");
        expect(entry).not.toHaveClass("o_disabled_offline");
    }
    expect(pipelineEntry).not.toHaveAttribute("aria-disabled");

    // A dropdown opened online follows the connection: its blocked entries are
    // dimmed and aria-disabled as soon as it drops, without being opened again.
    const reportingMenus = DISABLED_MENUS.filter(({ section }) => section === "Reporting");
    const reportingEntries = [];
    for (const { section, xmlid } of reportingMenus) {
        reportingEntries.push(await openNavbarEntryRendered(section, xmlid));
    }
    await setOffline(true);
    stepping.active = true;
    for (const entry of reportingEntries) {
        expect(entry).toHaveCount(1);
        expect(entry).toHaveAttribute("aria-disabled", "true");
        expect(entry).toHaveClass("o_disabled_offline");
    }
    // The visited pipeline entry keeps the framework's state.
    expect(pipelineEntry).not.toHaveAttribute("aria-disabled");
    expect(pipelineEntry).not.toHaveClass("o_disabled_offline");

    // Each entry stays inert by click, Enter and a direct `selectMenu`.
    for (const { id, section, xmlid } of DISABLED_MENUS) {
        const entry = await openNavbarEntryRendered(section, xmlid);
        expect(entry).toHaveAttribute("aria-disabled", "true");
        expect(entry).toHaveClass("o_disabled_offline");
        await click(queryFirst(entry));
        await animationFrame();
        queryFirst(await openNavbarEntryRendered(section, xmlid)).focus();
        await press("Enter");
        await animationFrame();
        await getService("menu").selectMenu(id);
        expect(currentView()).toBe(PIPELINE_VIEW);
    }
    await settle();
    expect(currentView()).toBe(PIPELINE_VIEW);
    expect.verifySteps([]);
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);

    // Back online, an open dropdown drops the attribute at once, and the entry opens
    // its view.
    const forecast = await openNavbarEntryRendered("Reporting", "crm.crm_menu_forecast");
    expect(forecast).toHaveAttribute("aria-disabled", "true");
    stepping.active = false;
    await setOffline(false);
    await animationFrame();
    for (const entry of reportingEntries) {
        expect(entry).toHaveCount(1);
        expect(entry).not.toHaveAttribute("aria-disabled");
        expect(entry).not.toHaveClass("o_disabled_offline");
    }
    await contains(forecast).click();
    await expectCurrentView(DISABLED_MENUS[0].view);

    // Another app's entries keep the framework's markup offline: the never-opened
    // Teams entry is dimmed by the framework, and no entry gets aria-disabled.
    await getService("menu").selectMenu(21);
    await expectCurrentView(`${STAGE_ACTION.xml_id}/list`);
    await setOffline(true);
    const otherEntry = (xmlid) => `.o_menu_sections .o_nav_entry[data-menu-xmlid='${xmlid}']`;
    expect(otherEntry("test.other_menu_stages")).not.toHaveClass("o_disabled_offline");
    expect(otherEntry("test.other_menu_teams")).toHaveClass("o_disabled_offline");
    for (const xmlid of ["test.other_menu_stages", "test.other_menu_teams"]) {
        expect(otherEntry(xmlid)).toHaveCount(1);
        expect(otherEntry(xmlid)).not.toHaveAttribute("aria-disabled");
    }
});

/** The command palette result named `name` (the menu path of a `/` menu command). */
function paletteCommand(name) {
    return `.o_command_palette .o_command:has(.o_command_name[title="${name}"])`;
}

/** Opens the command palette by its hotkey, if needed, and searches `searchValue`. */
async function searchCommandPalette(searchValue) {
    if (!queryAll(".o_command_palette").length) {
        await press(["control", "k"]);
        await animationFrame();
    }
    await contains(".o_command_palette_search input").edit(searchValue, { confirm: false });
    await animationFrame();
}

test.tags("desktop");
test("[Offline] command palette results of blocked CRM menus are dimmed and aria-disabled and stay inert", async () => {
    defineMenus([...CRM_MENUS, OTHER_APP_MENU]);
    const setOffline = mockOffline();
    const stepping = stepRoutes();
    stepping.active = false;
    patchWithCleanup(window, {
        open(url) {
            expect.step(`window.open ${url}`);
        },
    });
    await mountWithCleanup(WebClient);
    // The visited registry then holds every blocked action and the other app's
    // Stages; its Teams action is never opened.
    await getService("menu").selectMenu(21);
    await expectCurrentView(`${STAGE_ACTION.xml_id}/list`);
    await visitDisabledMenus();
    const blockedCommands = DISABLED_MENUS.map(({ id, section, view }) => ({
        name: `CRM / ${section} / ${getService("menu").getMenu(id).name}`,
        section,
        view,
    }));
    const commandsOf = (section) => blockedCommands.filter((command) => command.section === section);

    // Online, the results are the framework's: visited, so not dimmed, never
    // aria-disabled, and the selected one shows the "new tab" hint.
    const selectedHint = ".o_command_palette .o_command[aria-selected='true'] .o_command_focus";
    await searchCommandPalette("/Reporting");
    for (const { name } of commandsOf("Reporting")) {
        expect(paletteCommand(name)).toHaveCount(1);
        expect(paletteCommand(name)).not.toHaveAttribute("aria-disabled");
        expect(`${paletteCommand(name)} > a`).not.toHaveClass("o_disabled_offline");
    }
    expect(selectedHint).toHaveCount(1);

    // A palette opened online follows the connection, and the selected blocked result
    // loses its hint, as Ctrl+Enter opens nothing.
    await setOffline(true);
    stepping.active = true;
    for (const { name } of commandsOf("Reporting")) {
        expect(paletteCommand(name)).toHaveAttribute("aria-disabled", "true");
        expect(`${paletteCommand(name)} > a`).toHaveClass("o_disabled_offline");
    }
    expect(selectedHint).toHaveCount(0);

    // Offline, a click, Enter and Ctrl+Enter on each blocked result leave the palette
    // open on the current view, with no request and no new tab.
    for (const section of ["Reporting", "Configuration"]) {
        await searchCommandPalette(`/${section}`);
        for (const { name } of commandsOf(section)) {
            expect(paletteCommand(name)).toHaveAttribute("aria-disabled", "true");
            expect(`${paletteCommand(name)} > a`).toHaveClass("o_disabled_offline");
            await click(queryFirst(paletteCommand(name)));
            await animationFrame();
            expect(paletteCommand(name)).toHaveAttribute("aria-selected", "true");
            expect(`${paletteCommand(name)} .o_command_focus`).toHaveCount(0);
            await press("Enter");
            await animationFrame();
            await press(["control", "Enter"]);
            await animationFrame();
            expect(".o_command_palette").toHaveCount(1);
            expect(currentView()).toBe(PIPELINE_VIEW);
        }
    }
    await settle();
    expect(".o_command_palette").toHaveCount(1);
    expect(currentView()).toBe(PIPELINE_VIEW);
    expect.verifySteps([]);
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);

    // Other results keep the framework's markup: the visited pipeline and Stages are
    // not dimmed, the never-opened Teams is dimmed by the framework, and none is
    // aria-disabled.
    await searchCommandPalette("/Sales");
    expect(paletteCommand("CRM / Sales")).toHaveCount(1);
    expect(paletteCommand("CRM / Sales")).not.toHaveAttribute("aria-disabled");
    expect(`${paletteCommand("CRM / Sales")} > a`).not.toHaveClass("o_disabled_offline");
    await searchCommandPalette("/Other app");
    for (const name of ["Other app / Stages", "Other app / Teams"]) {
        expect(paletteCommand(name)).toHaveCount(1);
        expect(paletteCommand(name)).not.toHaveAttribute("aria-disabled");
    }
    expect(`${paletteCommand("Other app / Stages")} > a`).not.toHaveClass("o_disabled_offline");
    expect(`${paletteCommand("Other app / Teams")} > a`).toHaveClass("o_disabled_offline");

    // Back online, an open palette drops the dimming at once, and a blocked menu's
    // result opens its view.
    await searchCommandPalette("/Reporting");
    stepping.active = false;
    await setOffline(false);
    await animationFrame();
    for (const { name } of commandsOf("Reporting")) {
        expect(paletteCommand(name)).not.toHaveAttribute("aria-disabled");
        expect(`${paletteCommand(name)} > a`).not.toHaveClass("o_disabled_offline");
    }
    expect(selectedHint).toHaveCount(1);
    const [forecast] = blockedCommands;
    await click(queryFirst(paletteCommand(forecast.name)));
    await expectCurrentView(forecast.view);
    expect(".o_command_palette").toHaveCount(0);
    expect.verifySteps([]);
});

test.tags("mobile");
test("[Offline] phone sidebar entries of blocked views are dimmed after an online visit", async () => {
    defineMenus([
        ...CRM_MENUS,
        {
            id: 20,
            name: "Other app",
            xmlid: "test.other_menu_root",
            actionID: STAGE_ACTION.id,
            appID: 20,
            children: [
                {
                    id: 21,
                    name: "Stages",
                    xmlid: "test.other_menu_stages",
                    actionID: STAGE_ACTION.id,
                    appID: 20,
                },
                {
                    id: 22,
                    name: "Teams",
                    xmlid: "test.other_menu_teams",
                    actionID: TEAM_ACTION.id,
                    appID: 20,
                },
            ],
        },
    ]);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await getService("menu").selectMenu(2);
    expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");

    // Online visit of every entry, a lead form opened from the forecast and the
    // pipeline report's list: each marks a view of its action visited.
    for (const { id, view } of DISABLED_MENUS) {
        await getService("menu").selectMenu(id);
        await expectCurrentView(view);
    }
    await getService("menu").selectMenu(4);
    await getService("action").switchView("list");
    await contains(".o_data_row:contains(Lead 1) .o_data_cell:eq(0)").click();
    await expectCurrentView("crm.crm_lead_action_forecast/form");
    await getService("menu").selectMenu(5);
    await getService("action").switchView("list");
    expect(currentView()).toBe("crm.crm_opportunity_report_action/list");
    await getService("menu").selectMenu(2);
    expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    await flushStartupSync();

    // The sidebar is rendered in a portal on the body, outside the test fixture.
    const inBody = { root: document.body };
    const entrySelector = (xmlid) => `.o_app_menu_sidebar li[data-menu-xmlid='${xmlid}']`;
    const sidebarEntry = (xmlid) => queryAll(entrySelector(xmlid), inBody);
    const pipelineEntry = () => sidebarEntry("crm.crm_menu_sales");
    // Online, the sidebar renders the framework's entries.
    await contains("a.o_menu_toggle").click();
    for (const { xmlid } of DISABLED_MENUS) {
        expect(sidebarEntry(xmlid)).toHaveAttribute("class", "py-2");
        expect(sidebarEntry(xmlid)).not.toHaveAttribute("aria-disabled");
    }
    expect(pipelineEntry()).toHaveAttribute("class", "fw-bold text-900 py-3");

    // Offline, the open sidebar dims every entry at once; the visited pipeline entry
    // keeps the framework's state.
    await setOffline(true);
    for (const { xmlid } of DISABLED_MENUS) {
        expect(sidebarEntry(xmlid)).toHaveClass("o_disabled_offline");
        expect(sidebarEntry(xmlid)).toHaveAttribute("aria-disabled", "true");
    }
    expect(pipelineEntry()).not.toHaveClass("o_disabled_offline");
    expect(pipelineEntry()).not.toHaveAttribute("aria-disabled");
    // A tap on an entry closes the sidebar and leaves the current view in place.
    for (const { xmlid } of DISABLED_MENUS) {
        if (!sidebarEntry(xmlid).length) {
            await contains("a.o_menu_toggle").click();
        }
        expect(sidebarEntry(xmlid)).toHaveClass("o_disabled_offline");
        await click(sidebarEntry(xmlid)[0]);
        await settle();
        expect(queryAll(".o_app_menu_sidebar", inBody)).toHaveCount(0);
        expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    }
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);

    // Online again, the entries are the framework's, and a tap opens the view.
    await setOffline(false);
    await animationFrame();
    await contains("a.o_menu_toggle").click();
    for (const { xmlid } of DISABLED_MENUS) {
        expect(sidebarEntry(xmlid)).toHaveAttribute("class", "py-2");
        expect(sidebarEntry(xmlid)).not.toHaveAttribute("aria-disabled");
    }
    await contains(entrySelector("crm.crm_menu_forecast"), inBody).click();
    await expectCurrentView(`${FORECAST_ACTION.xml_id}/kanban`);

    // Another app's phone sidebar is left as the framework renders it, even for an
    // entry whose action was never visited.
    await getService("menu").selectMenu(21);
    await expectCurrentView(`${STAGE_ACTION.xml_id}/list`);
    await setOffline(true);
    expect(getService(OfflinePlugin).isAvailableOffline(TEAM_ACTION.id)).toBe(false);
    await contains("a.o_menu_toggle").click();
    for (const xmlid of ["test.other_menu_stages", "test.other_menu_teams"]) {
        expect(sidebarEntry(xmlid)).toHaveCount(1);
        expect(sidebarEntry(xmlid)).not.toHaveClass("o_disabled_offline");
        expect(sidebarEntry(xmlid)).not.toHaveAttribute("aria-disabled");
    }
});

test("[Offline] URL and breadcrumb restoration of blocked views fails closed", async () => {
    const setOffline = mockOffline();
    const stepping = stepRoutes(
        (route) => route.includes("/crm.lead/") || route === "/web/action/load"
    );
    stepping.active = false;
    await mountWithCleanup(WebClient);
    // Online: the forecast, whose URL state and breadcrumb are kept...
    await getService("action").doAction(FORECAST_ACTION.id);
    await expectCurrentView("crm.crm_lead_action_forecast/kanban");
    await runAllTimers();
    const forecastState = { ...router.current };
    expect(forecastState.action).toBe(FORECAST_ACTION.id);
    const forecastJsId = getService("action").currentController.jsId;
    // ... then the pipeline, opened above it in the breadcrumbs.
    await getService("action").doAction(PIPELINE_ACTION.id);
    await expectCurrentView("crm.crm_lead_action_pipeline/kanban");
    await flushStartupSync();

    await setOffline(true);
    stepping.active = true;
    // The forecast's URL state is refused (the web client then opens its default
    // app instead): the pipeline stays.
    expect(await getService("action").loadState(forecastState)).toBe(false);
    await settle();
    expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    expect(".o_kanban_renderer").toHaveCount(1);
    // Restoring the forecast breadcrumb renders the offline helper, not the forecast.
    await getService("action").restore(forecastJsId);
    await settle();
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    expect(".o_kanban_renderer").toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);

    // Online, the forecast blocked at mount loads, and its URL state opens it again.
    await setOffline(false);
    await animationFrame();
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(0);
    expect(".o_kanban_renderer").toHaveCount(1);
    expect.verifySteps(["/web/dataset/call_kw/crm.lead/web_read_group"]);
    stepping.active = false;
    await getService("action").doAction(PIPELINE_ACTION.id, { clearBreadcrumbs: true });
    await expectCurrentView("crm.crm_lead_action_pipeline/kanban");
    await getService("action").loadState(forecastState);
    await expectCurrentView("crm.crm_lead_action_forecast/kanban");
    expect(".o_kanban_renderer").toHaveCount(1);
});

test("[Offline] blocked actions requested by a numeric-string id stay closed", async () => {
    // Offline root load served from the cache: the opportunities list.
    expect.errors(1);
    const setOffline = mockOffline();
    const stepping = stepRoutes(
        (route) => route.includes("/crm.lead/") || route === "/web/action/load"
    );
    stepping.active = false;
    await mountWithCleanup(WebClient);
    // Online, actions requested by their id as a string, which the server reads as
    // that id: the forecast and the pipeline report (both disabled offline), and the
    // opportunities list.
    const blocked = [
        [FORECAST_ACTION, "kanban"],
        [OPPORTUNITY_REPORT_ACTION, "graph"],
    ];
    for (const [action, viewType] of [...blocked, [LEADS_ACTION, "list"]]) {
        await getService("action").doAction(String(action.id));
        await expectCurrentView(`${action.xml_id}/${viewType}`);
    }
    await getService("action").doAction(PIPELINE_ACTION.id, { clearBreadcrumbs: true });
    await expectCurrentView("crm.crm_lead_action_pipeline/kanban");
    await flushStartupSync();

    await setOffline(true);
    stepping.active = true;
    // Each disabled action is identified from its online load (the same string
    // request): the pipeline stays, with no helper, dialog or request.
    for (const [action] of blocked) {
        expect(CRM_OFFLINE_DISABLED_ACTIONS.has(action.xml_id)).toBe(true);
        await getService("action").doAction(String(action.id));
        await settle();
        expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    }
    expect(".o_kanban_renderer").toHaveCount(1);
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
    // Any other action requested that way still opens, through the original.
    await getService("action").doAction(String(LEADS_ACTION.id));
    await expectCurrentView("crm.crm_lead_opportunities/list");
    expect.verifySteps([LEAD_LIST_LOAD]);
    // The failed request is reported once the cache has served the list, possibly
    // after the list shows.
    await expect.waitForErrors([LEAD_LIST_LOAD]);
    stepping.active = false;

    // Online, the forecast opens again.
    await reconnect(setOffline);
    await getService("action").doAction(String(FORECAST_ACTION.id));
    await expectCurrentView("crm.crm_lead_action_forecast/kanban");
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(0);
});

/**
 * An action id written with the decimal digits of another Unicode script, whose zero
 * is at code point `zero` (the server's `int()` reads every such form as the id).
 *
 * @param {number} zero
 * @param {number} id
 * @returns {string}
 */
function idInDigits(zero, id) {
    return [...String(id)].map((digit) => String.fromCodePoint(zero + Number(digit))).join("");
}

/**
 * The forms of an action id other than the integer that the server reads as that id:
 * its numeric string, padded with Unicode whitespace, signed, zero-filled, with
 * underscores between its digits, and written with other scripts' decimal digits
 * (Arabic-Indic, fullwidth, and the mathematical bold and monospace digits, outside
 * the Basic Multilingual Plane).
 *
 * @param {number} id
 * @returns {string[]}
 */
function actionIdForms(id) {
    return [
        String(id),
        ` ${id}\n`,
        `\u00a0+${id}\u2003`,
        `00${id}`,
        [...String(id)].join("_"),
        `\u3000${idInDigits(0x0660, id)}`,
        idInDigits(0xff10, id),
        idInDigits(0x1d7ce, id),
        idInDigits(0x1d7f6, id),
    ];
}

test("[Offline] blocked actions known by one id form stay closed under every other", async () => {
    const setOffline = mockOffline();
    const stepping = stepRoutes(
        (route) => route.includes("/crm.lead/") || route === "/web/action/load"
    );
    stepping.active = false;
    await mountWithCleanup(WebClient);
    // Online, the forecast is loaded by its integer id, the recurring plans by their
    // id as a string.
    await getService("action").doAction(FORECAST_ACTION.id);
    await expectCurrentView("crm.crm_lead_action_forecast/kanban");
    await getService("action").doAction(String(RECURRING_PLAN_ACTION.id));
    await expectCurrentView("crm.crm_recurring_plan_action/list");
    await getService("action").doAction(PIPELINE_ACTION.id, { clearBreadcrumbs: true });
    await expectCurrentView("crm.crm_lead_action_pipeline/kanban");
    await flushStartupSync();
    const lostLoad = /Connection to "\/web\/action\/load" couldn't be established/;

    await setOffline(true);
    stepping.active = true;
    // Every other form of the forecast's id, and a number the server truncates to it:
    // `doAction` and the URL state stop with no request.
    for (const request of [...actionIdForms(FORECAST_ACTION.id), FORECAST_ACTION.id + 0.5]) {
        await getService("action").doAction(request);
        expect(await getService("action").loadState({ action: request })).toBe(false);
        const nestedState = { action: request, actionStack: [{ action: request }] };
        expect(await getService("action").loadState(nestedState)).toBe(false);
    }
    // The recurring plans, known by their id as a string, by the integer.
    await getService("action").doAction(RECURRING_PLAN_ACTION.id);
    expect(await getService("action").loadState({ action: RECURRING_PLAN_ACTION.id })).toBe(false);
    await settle();
    expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    expect(".o_kanban_renderer").toHaveCount(1);
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
    // Another id (the sign is applied) and an action of another app the guards do not
    // know: each goes to the original, whose own load alone is attempted.
    for (const request of [`-${FORECAST_ACTION.id}`, String(CONTACTS_ACTION.id)]) {
        await expect(getService("action").doAction(request)).rejects.toThrow(lostLoad);
        expect.verifySteps(["/web/action/load"]);
    }
    expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    stepping.active = false;

    // Online, both open again by either form of their id.
    await reconnect(setOffline);
    await getService("action").doAction(String(FORECAST_ACTION.id));
    await expectCurrentView("crm.crm_lead_action_forecast/kanban");
    expect(await getService("action").loadState({ action: RECURRING_PLAN_ACTION.id })).toBe(true);
    await expectCurrentView("crm.crm_recurring_plan_action/list");
});

test("[Offline] the action stored in the session is known by every form of its id", async () => {
    const setOffline = mockOffline();
    stepRoutes((route) => route === "/web/action/load");
    await mountWithCleanup(WebClient);
    // Online, the forecast is opened from its descriptor: no action load, so the
    // session's stored action alone identifies it.
    await getService("action").doAction({ ...FORECAST_ACTION, type: "ir.actions.act_window" });
    await expectCurrentView("crm.crm_lead_action_forecast/kanban");
    await flushStartupSync();
    expect(JSON.parse(browser.sessionStorage.getItem("current_action")).id).toBe(
        FORECAST_ACTION.id
    );
    expect.verifySteps([]);

    await setOffline(true);
    // The mounted forecast shows the offline helper; no form of its id opens it.
    for (const request of [FORECAST_ACTION.id, ...actionIdForms(FORECAST_ACTION.id)]) {
        await getService("action").doAction(request);
        expect(await getService("action").loadState({ action: request })).toBe(false);
    }
    await settle();
    expect(currentView()).toBe("crm.crm_lead_action_forecast/kanban");
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);

    // Online, the forecast shows again and opens by its id as a string.
    await reconnect(setOffline);
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(0);
    expect(".o_kanban_renderer").toHaveCount(1);
    await getService("action").doAction(String(FORECAST_ACTION.id), { clearBreadcrumbs: true });
    await expectCurrentView("crm.crm_lead_action_forecast/kanban");
    expect.verifySteps(["/web/action/load"]);
});

test("[Offline] action buttons naming a disabled action open nothing, whatever their model", async () => {
    const setOffline = mockOffline();
    const stepping = stepRoutes();
    stepping.active = false;
    const { env } = await makeMockServer();
    const partnerId = env["res.partner"].create({ name: "Azure Interior" });
    await mountWithCleanup(WebClient);
    /** A `type="action"` button call, as a view button issues it, without a model. */
    const actionButton = (name, params = {}) =>
        getService("action").doActionButton({ type: "action", name, context: {}, ...params });
    // Online, the recurring plans and the lead mail composer open from buttons naming
    // their `xml_id`: those exact action loads are now in the RPC cache, which serves
    // them again with no request.
    await actionButton(RECURRING_PLAN_ACTION.xml_id);
    await expectCurrentView("crm.crm_recurring_plan_action/list");
    await actionButton(MAIL_COMPOSE_ACTION.xml_id);
    await waitFor(".modal .o_form_view .o_field_widget[name=body]");
    await cancelDialog();
    await getService("action").doAction(PIPELINE_ACTION.id, { clearBreadcrumbs: true });
    await expectCurrentView("crm.crm_lead_action_pipeline/kanban");
    await flushStartupSync();

    await setOffline(true);
    stepping.active = true;
    // Each action named by its `xml_id` (the cached call included), its integer id or
    // any other form of its id, on a button without a model and on a partner button:
    // nothing loads, opens or is queued.
    const partner = { resModel: "res.partner", resId: partnerId, resIds: [partnerId] };
    for (const action of [RECURRING_PLAN_ACTION, MAIL_COMPOSE_ACTION]) {
        expect(CRM_OFFLINE_DISABLED_ACTIONS.has(action.xml_id)).toBe(true);
        for (const name of [action.xml_id, action.id, ...actionIdForms(action.id)]) {
            await actionButton(name);
            await actionButton(name, partner);
        }
    }
    await settle();
    expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    expect(".o_kanban_renderer").toHaveCount(1);
    expect(".o_list_view").toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
    expect(queued("crm.recurring.plan")).toEqual([]);
    expect(queued("mail.compose.message")).toEqual([]);
    stepping.active = false;

    // Online, each opens again from a partner button naming its id.
    await reconnect(setOffline);
    await actionButton(String(MAIL_COMPOSE_ACTION.id), partner);
    await waitFor(".modal .o_form_view .o_field_widget[name=body]");
    await cancelDialog();
    await actionButton(RECURRING_PLAN_ACTION.id, partner);
    await expectCurrentView("crm.crm_recurring_plan_action/list");
    expect(".o_list_view").toHaveCount(1);
});

test("[Offline] views of a disabled action stay closed however they are reached", async () => {
    const setOffline = mockOffline();
    const stepping = stepRoutes(
        (route) => route === "/web/action/load" || route.includes("/crm.recurring.plan/")
    );
    stepping.active = false;
    await mountWithCleanup(WebClient);
    const helper = ".o_action_manager .o_view_nocontent .fa-chain-broken";
    // Online: the recurring plans, whose breadcrumb is then kept below the pipeline.
    await getService("action").doAction(RECURRING_PLAN_ACTION.id);
    await expectCurrentView("crm.crm_recurring_plan_action/list");
    expect(".o_list_view .o_data_row").toHaveCount(1);
    const plansJsId = getService("action").currentController.jsId;
    await flushStartupSync();

    // Mounted online, the list gives way to the offline helper as soon as the
    // connection drops, so no plan can be edited, created, archived or deleted.
    await setOffline(true);
    stepping.active = true;
    await animationFrame();
    expect(helper).toHaveCount(1);
    expect(".o_list_view").toHaveCount(0);
    expect.verifySteps([]);
    stepping.active = false;
    await reconnect(setOffline);
    await waitFor(".o_list_view .o_data_row");
    expect(helper).toHaveCount(0);

    // Reached offline by its breadcrumb, which the action guards do not see (as an id
    // loaded in an earlier page session, then answered from the disk cache), the list
    // mounts the offline helper, with no request and nothing queued.
    await getService("action").doAction(PIPELINE_ACTION.id);
    await expectCurrentView("crm.crm_lead_action_pipeline/kanban");
    await setOffline(true);
    stepping.active = true;
    await getService("action").restore(plansJsId);
    await settle();
    expect(currentView()).toBe("crm.crm_recurring_plan_action/list");
    expect(helper).toHaveCount(1);
    expect(".o_list_view").toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
    expect(queued("crm.recurring.plan")).toEqual([]);

    // Online, the list blocked at mount loads.
    await setOffline(false);
    await waitFor(".o_list_view .o_data_row");
    expect(helper).toHaveCount(0);
    expect.verifySteps(["/web/dataset/call_kw/crm.recurring.plan/web_search_read"]);
});

test("[Offline] meeting from a lead activity issues no request", async () => {
    onRpc("mail.activity", "action_create_calendar_event", ({ args }) =>
        stepServerCall("action_create_calendar_event", args[0])
    );
    const { env } = await makeMockServer();
    const activityValues = { user_id: serverState.userId, date_deadline: "2999-01-01" };
    const [leadActivityId, storedActivityId, partnerActivityId] = env["mail.activity"].create([
        { ...activityValues, res_model: "crm.lead", res_id: 1 },
        { ...activityValues, res_model: "crm.lead", res_id: 2 },
        { ...activityValues, res_model: "res.partner", res_id: serverState.partnerId },
    ]);
    const setOffline = mockOffline();
    stepRoutes((route) => route.startsWith("/web/dataset/call_button/"));
    await mountWithCleanup(WebClient);
    // The second lead's activity is in the mail store, as the lead's chatter and
    // activity widgets load it.
    getService("mail.store")["mail.activity"].insert({
        id: storedActivityId,
        res_model: "crm.lead",
        res_id: 2,
    });
    // Another app's view is displayed.
    await getService("action").doAction(CONTACTS_ACTION.id);
    await expectCurrentView("contacts.action_contacts/list");
    await flushStartupSync();
    const calendarRoute = buttonRoute("mail.activity", "action_create_calendar_event");
    /** The activity form's "Schedule meeting" button call (`type="object"`). */
    const meetingButton = (resId, { context = {}, buttonContext = {} } = {}) =>
        getService("action").doActionButton({
            type: "object",
            name: "action_create_calendar_event",
            resModel: "mail.activity",
            resId,
            resIds: [resId],
            context,
            buttonContext,
        });

    await setOffline(true);
    // A lead's activity named by the call's own context or found in the mail store.
    for (const key of ["active_model", "default_res_model", "res_model"]) {
        await meetingButton(leadActivityId, { context: { [key]: "crm.lead", active_id: 1 } });
        await meetingButton(leadActivityId, { buttonContext: { [key]: "crm.lead" } });
    }
    await meetingButton(storedActivityId);
    await settle();
    expect.verifySteps([]);
    // Another model's activity, outside CRM: the original's own request alone.
    await expect(meetingButton(partnerActivityId)).rejects.toThrow(
        /Connection to "\/web\/dataset\/call_button\/mail.activity\/action_create_calendar_event"/
    );
    expect.verifySteps([calendarRoute]);
    expect(currentView()).toBe("contacts.action_contacts/list");
    expect(".modal").toHaveCount(0);

    // In a lead view (the pipeline, then a lead form opened online), a call without
    // context for an activity the store does not hold.
    await setOffline(false);
    await getService("action").doAction(PIPELINE_ACTION.id);
    await expectCurrentView("crm.crm_lead_action_pipeline/kanban");
    await setOffline(true);
    await meetingButton(leadActivityId);
    await setOffline(false);
    await openLead(1);
    await expectCurrentView("crm.crm_lead_action_pipeline/form");
    await setOffline(true);
    await meetingButton(leadActivityId);
    await settle();
    expect.verifySteps([]);
    expect(queued("mail.activity")).toEqual([]);

    // Online, the method runs on the server.
    await reconnect(setOffline);
    await meetingButton(leadActivityId);
    expect.verifySteps([calendarRoute, `action_create_calendar_event [${leadActivityId}]`]);
});

// -----------------------------------------------------------------------------
// DISABLE: lead meetings (`calendar.event`) are neither saved nor queued offline
// -----------------------------------------------------------------------------

/** Meeting tags (`calendar.event.type`), coloured by the meeting form's tag editor. */
class CalendarEventType extends models.Model {
    _name = "calendar.event.type";

    name = fields.Char();
    color = fields.Integer();

    _records = [{ id: 1, name: "Customer Meeting", color: 2 }];
}

/**
 * Meetings (`calendar.event`), on calendar's own meeting form (`js_class="calendar_form"`,
 * `calendar.view_calendar_event_form`): its "Send email" header button, its attendees
 * (which its Delete sends), the lead the CRM inherit adds, its tags with their colour
 * editor, and the `active` field that gives its Action menu Archive. Its calendar opens
 * calendar's quick-create form (`calendar.view_calendar_event_form_quick_create`).
 */
class CalendarEvent extends models.Model {
    _name = "calendar.event";

    name = fields.Char({ string: "Meeting Subject", required: true });
    start = fields.Datetime();
    stop = fields.Datetime();
    active = fields.Boolean({ default: true });
    partner_ids = fields.Many2many({ string: "Attendees", relation: "res.partner" });
    opportunity_id = fields.Many2one({ string: "Opportunity", relation: "crm.lead" });
    categ_ids = fields.Many2many({ string: "Tags", relation: "calendar.event.type" });

    _records = [
        {
            id: 1,
            name: "Lead 1 demo",
            start: "2026-03-10 09:00:00",
            stop: "2026-03-10 10:00:00",
            opportunity_id: 1,
            categ_ids: [1],
        },
        {
            id: 2,
            name: "Team lunch",
            start: "2026-03-11 12:00:00",
            stop: "2026-03-11 13:00:00",
            categ_ids: [1],
        },
    ];

    _views = {
        form: /* xml */ `
            <form js_class="calendar_form">
                <header>
                    <button name="action_open_composer" type="object" string="Send email" class="btn btn-primary"/>
                </header>
                <sheet>
                    <field name="active" invisible="1"/>
                    <field name="name"/>
                    <field name="partner_ids" widget="many2many_tags"/>
                    <field name="opportunity_id"/>
                    <field name="categ_ids" widget="many2many_tags" options="{'color_field': 'color', 'on_tag_click': 'edit_color'}"/>
                </sheet>
            </form>`,
        "form,74": /* xml */ `
            <form js_class="calendar_quick_create_form_view">
                <field name="name"/>
                <field name="start"/>
                <field name="stop"/>
            </form>`,
        list: /* xml */ `<list><field name="name"/></list>`,
        calendar: /* xml */ `
            <calendar string="Meetings" date_start="start" date_stop="stop" mode="month" quick_create_view_id="74">
                <field name="name"/>
            </calendar>`,
        search: /* xml */ `<search/>`,
    };

    /** Read by the meeting form's model when it starts. */
    get_discuss_videocall_location() {
        return "/calendar/join_videocall/test";
    }

    action_open_composer(ids) {
        return stepServerCall("action_open_composer", ids);
    }
}

defineModels([CalendarEventType, CalendarEvent]);

/** The Calendar app's meetings (`calendar.action_calendar_event`), which Schedule Meeting returns. */
const CALENDAR_ACTION = {
    id: 73,
    xml_id: "calendar.action_calendar_event",
    name: "Meetings",
    res_model: "calendar.event",
    views: [
        [false, "calendar"],
        [false, "list"],
        [false, "form"],
    ],
};

defineActions([CALENDAR_ACTION]);

/** The context `crm.lead.action_schedule_meeting` gives the calendar of "Lead 1". */
const SCHEDULE_MEETING_CONTEXT = {
    search_default_opportunity_id: 1,
    default_opportunity_id: 1,
    default_partner_ids: [serverState.partnerId],
    calendar_include_user_events: true,
    default_team_id: 1,
    default_name: "Lead 1",
};

/** The context of the calendar a lead's activity scheduling opens ("Open Calendar"). */
const LEAD_ACTIVITY_CALENDAR_CONTEXT = {
    default_res_model: "crm.lead",
    default_res_id: 1,
    default_name: "Lead 1",
};

/** Name input of the meeting form. */
const MEETING_NAME = ".o_form_view .o_field_widget[name=name] input";

/** Every request that writes, copies or deletes a meeting or one of its tags. */
function isMeetingWriteRoute(route) {
    return (
        /^\/web\/dataset\/call_kw\/calendar\.event(\.type)?\/(web_save|write|create|unlink|copy|action_archive|action_unarchive|action_unlink_event|action_mass_archive)$/.test(
            route
        ) || route.startsWith("/web/dataset/call_button/calendar.event/")
    );
}

/**
 * Virtual time after which the timers started by the steps of the meeting calendar
 * tests have all run: the offline plugin's start-up sync (3 s after it starts), its
 * first connection check (2 s after going offline), its 1 s pause between replayed
 * calls, and the debounces of views and dialogs.
 *
 * Those tests cannot settle with `runAllTimers`: a displayed calendar (FullCalendar)
 * keeps a "today" timer that waits until the next day, up to 24 h, so `runAllTimers`
 * would advance a whole day of virtual time and run every short framework interval,
 * such as the bus election worker's 3 s check, tens of thousands of times. Under 3×
 * CPU throttling on the mobile preset, that made the lead meeting views test last
 * 6.7 s, above Hoot's 5 s default timeout; settled this way it lasts 3.2 s.
 */
const CALENDAR_SETTLE_MS = 60_000;

/** `settle` (and `flushStartupSync`) of the meeting calendar tests: see `CALENDAR_SETTLE_MS`. */
async function settleCalendar() {
    await advanceTime(CALENDAR_SETTLE_MS);
    await animationFrame();
}

/** `reconnect` of the meeting calendar tests: see `CALENDAR_SETTLE_MS`. */
async function reconnectCalendar(setOffline) {
    await setOffline(false);
    await settleCalendar();
}

test("[Offline] lead meeting form opened online saves, sends and queues nothing", async () => {
    const controllers = captureFormControllers();
    let actionMenus = null;
    patchWithCleanup(ActionMenus.prototype, {
        setup() {
            super.setup(...arguments);
            actionMenus = this;
        },
    });
    const setOffline = mockOffline();
    stepRoutes(isMeetingWriteRoute);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    const sendEmail = ".o_form_view button[name=action_open_composer]";

    /**
     * A lead's meeting form, opened online the ways CRM screens open one: the CRM
     * meetings action, the calendar of Schedule Meeting, the calendar of a lead's
     * activity scheduling, and a new meeting of Schedule Meeting.
     */
    const openers = [
        { open: () => getService("action").doAction(MEETING_ACTION.id), resId: 1 },
        {
            open: () =>
                getService("action").doAction(CALENDAR_ACTION.id, {
                    additionalContext: SCHEDULE_MEETING_CONTEXT,
                    viewType: "list",
                }),
            resId: 1,
        },
        {
            open: () =>
                getService("action").doAction(CALENDAR_ACTION.id, {
                    additionalContext: LEAD_ACTIVITY_CALENDAR_CONTEXT,
                    viewType: "list",
                }),
            resId: 1,
        },
        {
            open: () =>
                getService("action").doAction(CALENDAR_ACTION.id, {
                    additionalContext: SCHEDULE_MEETING_CONTEXT,
                    viewType: "list",
                }),
            resId: false,
        },
    ];

    for (const [index, { open, resId }] of openers.entries()) {
        const name = `Proposal call ${index}`;
        await open();
        await getService("action").switchView("form", resId ? { resId } : {});
        await animationFrame();
        expect(".o_form_view").toHaveCount(1);
        const originalName = queryFirst(MEETING_NAME).value;
        await contains(MEETING_NAME).edit(name, { confirm: "blur" });
        const controller = controllers.findLast((form) => form.props.resModel === "calendar.event");
        const { root } = controller.model;
        expect(root.isNew).toBe(!resId);
        await setOffline(true);

        // Offline, Save, a direct save of the meeting and the defence for a save
        // whose request loses the connection request and queue nothing; the form
        // keeps what was entered.
        await contains(".o_form_button_save").click();
        await settle();
        expect(await root.save()).toBe(false);
        expect(await root.save({ reload: false })).toBe(false);
        expect(root._offlineSave()).toBe(false);
        // Its buttons: "Send email" (framework-disabled, then forced) and the button
        // entry point, whose pre-save would otherwise queue the meeting.
        await revealFormControl(sendEmail);
        expect(sendEmail).not.toBeEnabled();
        forceClick(sendEmail);
        await settle();
        expect(
            await controller.beforeExecuteActionButton({
                name: "action_open_composer",
                type: "object",
            })
        ).toBe(false);
        await settle();
        expect(MEETING_NAME).toHaveValue(name);
        expect(root.isNew).toBe(!resId);
        expect(root.dirty).toBe(true);
        if (resId) {
            // A tag colour, which the form's tag editor saves on its own.
            const [tag] = root.data.categ_ids.records;
            await tag.update({ color: 5 });
            expect(await tag.save()).toBe(false);
            expect(tag._offlineSave()).toBe(false);
            // Its Action menu: Duplicate, Archive and Delete are dimmed and inert.
            await expectInertActionMenuItems(["Duplicate", "Archive", "Delete"], () => actionMenus);
            if (queryAll(".o-dropdown--menu .o_menu_item").length) {
                await toggleActionMenu();
            }
        }
        expect(".modal").toHaveCount(0);
        expect(queued("calendar.event")).toEqual([]);
        expect(queued("calendar.event.type")).toEqual([]);
        expect.verifySteps([]);

        // Discard still drops the entry: an existing meeting shows its saved values
        // again, a new one goes back to its list.
        await contains(".o_form_button_cancel").click();
        await settle();
        if (resId) {
            expect(MEETING_NAME).toHaveValue(originalName);
        } else {
            expect(".o_form_view").toHaveCount(0);
        }
        expect.verifySteps([]);

        // Back online, nothing is replayed, and Save writes the meeting.
        await reconnect(setOffline);
        expect(queued("calendar.event")).toEqual([]);
        expect.verifySteps([]);
        if (!resId) {
            await getService("action").switchView("form");
            await animationFrame();
        }
        await contains(MEETING_NAME).edit(name, { confirm: "blur" });
        await contains(".o_form_button_save").click();
        await expect.waitForSteps(["/web/dataset/call_kw/calendar.event/web_save"]);
        const savedId = resId || MockServer.env["calendar.event"].search([]).at(-1);
        expect(MockServer.env["calendar.event"].browse(savedId)[0]).toMatchObject({ name });
        if (resId) {
            await openActionMenu();
            expect(actionMenuItems("Archive")[0]).not.toHaveClass("pe-none");
            await toggleActionMenu();
        } else {
            // The new meeting is the lead's, as Schedule Meeting creates it.
            expect(MockServer.env["calendar.event"].browse(savedId)[0].opportunity_id).toBe(1);
        }
    }
});

test("[Offline] meeting form of another app keeps the framework offline save", async () => {
    const setOffline = mockOffline();
    stepRoutes(isMeetingWriteRoute);
    await mountWithCleanup(WebClient);
    // The Calendar app's own meetings, with no lead in their context.
    await getService("action").doAction(CALENDAR_ACTION.id, { viewType: "list" });
    await flushStartupSync();
    await getService("action").switchView("form", { resId: 2 });
    await animationFrame();
    await contains(MEETING_NAME).edit("Team dinner", { confirm: "blur" });
    await setOffline(true);

    // Offline, its Archive keeps the framework's offline availability, and Save
    // follows the framework, as before: the save is attempted, then queued.
    await openActionMenu();
    expect(actionMenuItems("Archive")[0]).not.toHaveClass("pe-none");
    await toggleActionMenu();
    await contains(".o_form_button_save").click();
    await settle();
    expect.verifySteps(["/web/dataset/call_kw/calendar.event/web_save"]);
    expect(queuedCalls("calendar.event").map(({ method, args }) => ({ method, args }))).toEqual([
        { method: "web_save", args: [[2], { name: "Team dinner" }] },
    ]);

    // Back online, the framework replays the queued save.
    await reconnect(setOffline);
    expect.verifySteps(["/web/dataset/call_kw/calendar.event/web_save"]);
    expect(queued("calendar.event")).toEqual([]);
    expect(MockServer.env["calendar.event"].browse(2)[0].name).toBe("Team dinner");
});

test("[Offline] lead meeting views opened online give way to the offline helper", async () => {
    const setOffline = mockOffline();
    const stepping = stepRoutes((route) => route.includes("/calendar.event"));
    stepping.active = false;
    await mountWithCleanup(WebClient);
    const helper = ".o_action_manager .o_view_nocontent .fa-chain-broken";

    // The calendar and list of a lead's meetings (Schedule Meeting, a lead's activity
    // scheduling), opened online: as soon as the connection drops they give way to
    // the offline helper, so no meeting can be created, moved, edited or deleted.
    for (const additionalContext of [SCHEDULE_MEETING_CONTEXT, LEAD_ACTIVITY_CALENDAR_CONTEXT]) {
        for (const [viewType, selector] of [
            ["calendar", ".o_calendar_view"],
            ["list", ".o_list_view"],
        ]) {
            await getService("action").doAction(CALENDAR_ACTION.id, {
                additionalContext,
                viewType,
            });
            await waitFor(selector);
            await settleCalendar();
            await setOffline(true);
            stepping.active = true;
            await animationFrame();
            expect(helper).toHaveCount(1);
            expect(selector).toHaveCount(0);
            expect.verifySteps([]);
            stepping.active = false;
            // Online, the view loads again.
            await reconnectCalendar(setOffline);
            await waitFor(selector);
            expect(helper).toHaveCount(0);
        }
    }

    // The Calendar app's own calendar and list stay mounted offline, as before.
    for (const [viewType, selector] of [
        ["calendar", ".o_calendar_view"],
        ["list", ".o_list_view"],
    ]) {
        await getService("action").doAction(CALENDAR_ACTION.id, { viewType });
        await waitFor(selector);
        await setOffline(true);
        await animationFrame();
        expect(selector).toHaveCount(1);
        expect(helper).toHaveCount(0);
        await reconnectCalendar(setOffline);
    }
});

test("[Offline] lead meeting quick create opened online keeps its entry and saves nothing", async () => {
    mockDate("2026-03-10 08:00:00");
    const controllers = captureFormControllers();
    const setOffline = mockOffline();
    stepRoutes(isMeetingWriteRoute);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(CALENDAR_ACTION.id, {
        additionalContext: SCHEDULE_MEETING_CONTEXT,
        viewType: "calendar",
    });
    await waitFor(".o_calendar_view");
    await settleCalendar();
    const helper = ".o_action_manager .o_view_nocontent .fa-chain-broken";
    const quickCreateName = ".modal .o_field_widget[name=name] input";
    const name = "Quick proposal call";

    // The quick create of the lead's meeting calendar, filled in online.
    await clickDate("2026-03-12");
    await waitFor(quickCreateName);
    await contains(quickCreateName).edit(name, { confirm: "blur" });
    const { root } = controllers.findLast((form) => form.props.resModel === "calendar.event").model;
    await setOffline(true);
    await animationFrame();

    // Offline, the dialog stays open over the calendar with its entry, and neither its
    // Save (framework-disabled, then forced) nor a direct save requests or queues the
    // meeting.
    expect(".modal .o_form_view").toHaveCount(1);
    expect(".o_calendar_view").toHaveCount(1);
    expect(helper).toHaveCount(0);
    expect(".modal .o_form_button_save").not.toBeEnabled();
    forceClick(".modal .o_form_button_save");
    await settleCalendar();
    expect(await root.save()).toBe(false);
    expect(root._offlineSave()).toBe(false);
    expect(".modal .o_form_view").toHaveCount(1);
    expect(quickCreateName).toHaveValue(name);
    expect(root.isNew).toBe(true);
    expect(queued("calendar.event")).toEqual([]);
    expect.verifySteps([]);

    // The dialog's close, which the framework keeps offline, drops the entry, and the
    // calendar then gives way to the offline helper.
    await contains(".modal button[aria-label=Close]").click();
    await waitFor(helper);
    expect(".modal").toHaveCount(0);
    expect(helper).toHaveCount(1);
    expect(".o_calendar_view").toHaveCount(0);
    expect.verifySteps([]);

    // Back online, nothing is replayed, and the quick create saves the lead's meeting.
    await reconnectCalendar(setOffline);
    await waitFor(".o_calendar_view");
    expect(queued("calendar.event")).toEqual([]);
    expect.verifySteps([]);
    await clickDate("2026-03-12");
    await waitFor(quickCreateName);
    await contains(quickCreateName).edit(name, { confirm: "blur" });
    await contains(".modal .o_form_button_save").click();
    await expect.waitForSteps(["/web/dataset/call_kw/calendar.event/web_save"]);
    expect(".modal").toHaveCount(0);
    const [savedId] = MockServer.env["calendar.event"].search([["name", "=", name]]);
    expect(MockServer.env["calendar.event"].browse(savedId)[0].opportunity_id).toBe(1);
});

/**
 * Contacts (`contacts.action_contacts`): an action of another app. Its id, like that
 * of `CUSTOMERS_ACTION`, is used by no other action of this file: the mock server
 * merges every action sharing an id into one.
 */
const CONTACTS_ACTION = {
    id: 48,
    xml_id: "contacts.action_contacts",
    name: "Contacts",
    res_model: "res.partner",
    views: [[false, "list"]],
};

/** Customers (`base.action_partner_form`): another action of another app. */
const CUSTOMERS_ACTION = {
    id: 47,
    xml_id: "base.action_partner_form",
    name: "Customers",
    res_model: "res.partner",
    views: [[false, "list"]],
};

defineActions([CONTACTS_ACTION, CUSTOMERS_ACTION]);

test("[Offline] other apps' action loads issue only the original's requests", async () => {
    const setOffline = mockOffline();
    const stepping = stepRoutes((route) => route === "/web/action/load");
    stepping.active = false;
    await mountWithCleanup(WebClient);
    await getService("action").doAction(PIPELINE_ACTION.id);
    await expectCurrentView("crm.crm_lead_action_pipeline/kanban");
    await flushStartupSync();
    const lostLoad = /Connection to "\/web\/action\/load" couldn't be established/;
    const lostBreadcrumbs = /Connection to "\/web\/action\/load_breadcrumbs" couldn't be/;

    await setOffline(true);
    stepping.active = true;
    // An action id the CRM guards do not know (never loaded): the original's own
    // load alone is attempted, and its failure is the original's.
    await expect(getService("action").doAction(CONTACTS_ACTION.id)).rejects.toThrow(lostLoad);
    expect.verifySteps(["/web/action/load"]);
    // A URL state of a single unknown action: the original's own load alone...
    const singleState = {
        action: CUSTOMERS_ACTION.id,
        actionStack: [{ action: CUSTOMERS_ACTION.id }],
    };
    await expect(getService("action").loadState(singleState)).rejects.toThrow(lostLoad);
    expect.verifySteps(["/web/action/load"]);
    // ... and of an unknown multi-level route (`/odoo/<action>/1/<action>`): none,
    // as the original fails first on its breadcrumbs.
    const nestedState = {
        action: CUSTOMERS_ACTION.id,
        active_id: 1,
        actionStack: [
            { action: CONTACTS_ACTION.id },
            { action: CUSTOMERS_ACTION.id, active_id: 1 },
        ],
    };
    await expect(getService("action").loadState(nestedState)).rejects.toThrow(lostBreadcrumbs);
    await settle();
    expect.verifySteps([]);
    expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    expect(".o_kanban_renderer").toHaveCount(1);
    expect(".modal").toHaveCount(0);

    // Online, each request passes through to the original with its one load.
    await reconnect(setOffline);
    await getService("action").doAction(CONTACTS_ACTION.id);
    await expectCurrentView("contacts.action_contacts/list");
    expect.verifySteps(["/web/action/load"]);
    expect(await getService("action").loadState(singleState)).toBe(true);
    await expectCurrentView("base.action_partner_form/list");
    expect.verifySteps(["/web/action/load"]);
});

test("[Offline] view blocked at mount: a failed reconnection load is retried or reported once", async () => {
    // The server errors injected into two reconnection loads, each shown by the
    // framework once.
    expect.errors(2);
    const LEAD_VIEWS_LOAD = "/web/dataset/call_kw/crm.lead/get_views";
    /**
     * The next view load: `"lost"` (502 answer) or `"refused"`; `held` delays it,
     * and fails it when rejected.
     */
    const viewLoads = { next: false, held: null };
    onRpc("crm.lead", "get_views", async ({ parent }) => {
        expect.step("get_views");
        if (viewLoads.next === "refused") {
            viewLoads.next = false;
            throw makeServerError({ message: "View load refused" });
        }
        await viewLoads.held;
        return parent();
    });
    const setOffline = mockOffline();
    onRpc("/*", (request) => {
        if (viewLoads.next === "lost" && new URL(request.url).pathname === LEAD_VIEWS_LOAD) {
            viewLoads.next = false;
            expect.step("get_views lost");
            return new Response("", { status: 502 });
        }
    });
    const pivotViews = [];
    patchWithCleanup(View.prototype, {
        setup() {
            super.setup(...arguments);
            if (this.props.resModel === "crm.lead" && this.props.type === "pivot") {
                pivotViews.push(this);
            }
        },
    });
    await mountWithCleanup(WebClient);
    await flushStartupSync();
    const offlinePlugin = getService(OfflinePlugin);
    const helper = ".o_action_manager .o_view_nocontent .fa-chain-broken";

    // A lead pivot report never opened online (no CRM `xml_id`, views not cached)
    // mounts the offline helper, with no view request.
    await setOffline(true);
    await getService("action").doAction({
        type: "ir.actions.act_window",
        name: "Revenue by team",
        res_model: "crm.lead",
        views: [[false, "pivot"]],
    });
    await animationFrame();
    expect(helper).toHaveCount(1);
    const [view] = pivotViews;
    expect(view.crmLoadPending).toBe(true);
    expect.verifySteps([]);

    // The connection drops again during the reconnection load: the helper stays and
    // nothing is raised.
    viewLoads.next = "lost";
    await setOffline(false);
    await expect.waitForSteps(["get_views lost"]);
    await animationFrame();
    expect(offlinePlugin.isOffline()).toBe(true);
    expect(helper).toHaveCount(1);
    expect(view.crmLoadPending).toBe(true);
    expect.verifyErrors([]);

    // The next reconnection loads again; a server error reaches the framework error
    // handling once, and the view stays pending.
    viewLoads.next = "refused";
    await setOffline(false);
    await expect.waitForSteps(["get_views"]);
    await waitFor(".o_error_dialog:contains(View load refused)");
    expect(helper).toHaveCount(1);
    expect(view.crmLoadPending).toBe(true);
    expect.verifyErrors(["View load refused"]);
    await contains(".o_error_dialog .modal-footer .btn-primary").click();

    // A reconnection while the next load runs shares it: when that load then fails
    // with a server error, the error is reported once, and the view stays pending.
    // Hoot counts one error object once, so the dialog count shows a second report.
    const { promise: refusedLoad, reject: refuse } = Promise.withResolvers();
    viewLoads.held = refusedLoad;
    await setOffline(true);
    await setOffline(false);
    await expect.waitForSteps(["get_views"]);
    await setOffline(true);
    await setOffline(false);
    expect.verifySteps([]);
    refuse(makeServerError({ message: "View load refused" }));
    await waitFor(".o_error_dialog:contains(View load refused)");
    await animationFrame();
    expect(".o_error_dialog").toHaveCount(1);
    expect(helper).toHaveCount(1);
    expect(view.crmLoadPending).toBe(true);
    expect.verifyErrors(["View load refused"]);
    await contains(".o_error_dialog .modal-footer .btn-primary").click();
    expect(".o_error_dialog").toHaveCount(0);

    // Two reconnections while the next load runs start it once, and a concurrent
    // call shares it; once it ends, the view renders.
    const { promise: held, resolve: release } = Promise.withResolvers();
    viewLoads.held = held;
    await setOffline(true);
    await setOffline(false);
    await expect.waitForSteps(["get_views"]);
    const running = view.crmLoadPendingView();
    expect(running).toBeInstanceOf(Promise);
    expect(view.crmLoadPendingView()).toBe(running);
    await setOffline(true);
    await setOffline(false);
    expect.verifySteps([]);
    release();
    await running;
    await animationFrame();
    expect(".o_pivot_view").toHaveCount(1);
    expect(helper).toHaveCount(0);
    expect(view.crmLoadPending).toBe(false);
    expect.verifySteps([]);
});

/** View id of `PARTNER_FORM_ARCH`, registered for the tests that open it. */
const PARTNER_FORM_VIEW_ID = 500;

/** Configuration > Lost Reasons (`crm.crm_lost_reason_action`). */
const LOST_REASON_ACTION = {
    id: 41,
    xml_id: "crm.crm_lost_reason_action",
    name: "Lost Reasons",
    res_model: "crm.lost.reason",
    views: [
        [false, "list"],
        [false, "form"],
    ],
};

defineActions([LOST_REASON_ACTION]);

test("[Offline] partner opportunities and CRM settings buttons inert", async () => {
    // The partner form with the CRM stat button, for the shared `res.partner` mock.
    registerInlineViewArchs("res.partner", { [`form,${PARTNER_FORM_VIEW_ID}`]: PARTNER_FORM_ARCH });
    onRpc("res.partner", "action_view_opportunity", ({ args }) =>
        stepServerCall("action_view_opportunity", args[0])
    );
    const setOffline = mockOffline();
    stepRoutes(
        (route) => route === "/web/action/load" || route.startsWith("/web/dataset/call_button/")
    );
    // The settings' `web_save` requests, stepped while forced button activations run
    // offline and on the reconnection that follows them.
    const settingsSaves = stepRoutes(
        (route) => route === "/web/dataset/call_kw/res.config.settings/web_save"
    );
    settingsSaves.active = false;
    const { env } = await makeMockServer();
    const partnerId = env["res.partner"].create({ name: "Azure Interior", opportunity_count: 2 });
    await mountWithCleanup(WebClient);
    await flushStartupSync();

    /**
     * Visits a form online, disconnects, and checks its DISABLE buttons: disabled,
     * inert by click and keyboard, and a direct `doActionButton` (as the form would
     * issue it) requests nothing; then reconnects.
     */
    async function expectInertButtons(buttons, { resModel, resId, context = {} }) {
        await setOffline(true);
        for (const { selector, name, type = "object" } of buttons) {
            await revealFormControl(selector);
            expect(selector).toHaveCount(1);
            expect(selector).not.toBeEnabled();
            await activateByPointerAndKeyboard(selector);
            await callButton({ resModel, name, resId, type, context });
        }
        await settle();
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);
        await setOffline(false);
        await animationFrame();
    }

    // Partner form: the opportunities stat button.
    await getService("action").doAction({
        type: "ir.actions.act_window",
        res_model: "res.partner",
        res_id: partnerId,
        views: [[PARTNER_FORM_VIEW_ID, "form"]],
    });
    expect.verifySteps([]);
    const opportunities = "button[name=action_view_opportunity]";
    await expectInertButtons([{ selector: opportunities, name: "action_view_opportunity" }], {
        resModel: "res.partner",
        resId: partnerId,
    });
    await revealFormControl(opportunities);
    await contains(opportunities).click();
    await expect.waitForSteps([
        buttonRoute("res.partner", "action_view_opportunity"),
        `action_view_opportunity [${partnerId}]`,
    ]);

    // Lost reason form: the lost leads stat button.
    await getService("action").doAction(LOST_REASON_ACTION.id);
    await contains(".o_data_row .o_data_cell").click();
    expect.verifySteps(["/web/action/load"]);
    const lostLeads = "button[name=action_lost_leads]";
    await expectInertButtons([{ selector: lostLeads, name: "action_lost_leads" }], {
        resModel: "crm.lost.reason",
        resId: 1,
    });
    await revealFormControl(lostLeads);
    await contains(lostLeads).click();
    await expect.waitForSteps([buttonRoute("crm.lost.reason", "action_lost_leads"), "action_lost_leads [1]"]);

    // CRM settings opened online: the values entered stay, the buttons are inert.
    await getService("action").doAction(SETTINGS_ACTION.id);
    expect.verifySteps(["/web/action/load"]);
    await contains(".o_field_widget[name=group_use_recurring_revenues] input").click();
    const settingsButtons = [
        { selector: "button[name='crm.crm_recurring_plan_action']", name: "crm.crm_recurring_plan_action", type: "action" },
        { selector: `button[name='${PLS_UPDATE_ACTION.id}']`, name: `${PLS_UPDATE_ACTION.id}`, type: "action" },
        { selector: "button[name=action_crm_assign_leads]", name: "action_crm_assign_leads" },
    ];
    await setOffline(true);
    expect(".o_field_widget[name=group_use_recurring_revenues] input").toBeChecked();
    await setOffline(false);
    await expectInertButtons(settingsButtons, {
        resModel: "res.config.settings",
        context: { module: "crm" },
    });
    expect(".o_field_widget[name=group_use_recurring_revenues] input").toBeChecked();
    // A forced activation of each disabled button stops before the settings record
    // (transient, and changed) is saved: no `web_save` is attempted, queued or replayed.
    await setOffline(true);
    settingsSaves.active = true;
    for (const { selector } of settingsButtons) {
        await revealFormControl(selector);
        forceClick(selector);
        await settle();
    }
    expect(".modal").toHaveCount(0);
    expect(queued("res.config.settings")).toEqual([]);
    expect.verifySteps([]);
    await reconnect(setOffline);
    expect(queued("res.config.settings")).toEqual([]);
    expect.verifySteps([]);
    settingsSaves.active = false;
    expect(".o_field_widget[name=group_use_recurring_revenues] input").toBeChecked();

    // CRM settings opened offline: the offline helper, with no view or data request
    // (an action without `xml_id`, so that only the view-mount guard applies).
    const settingsWithoutXmlId = {
        type: "ir.actions.act_window",
        name: "Settings",
        res_model: "res.config.settings",
        views: [[false, "form"]],
        context: { module: "crm", bin_size: false },
    };
    await getService("action").doAction(PIPELINE_ACTION.id);
    await flushStartupSync();
    await setOffline(true);
    expect.verifySteps(["/web/action/load"]);
    await getService("action").doAction(settingsWithoutXmlId);
    await settle();
    expect(".o_action_manager .o_view_nocontent .fa-chain-broken").toHaveCount(1);
    expect(".o_form_view").toHaveCount(0);
    expect.verifySteps([]);
    await setOffline(false);
    await animationFrame();
    expect(".o_form_view .o_field_widget[name=group_use_recurring_revenues]").toHaveCount(1);

    // Online, each settings button runs (the form saves its new record first; the
    // first settings record was saved when it was left).
    const settingsId = MockServer.env["res.config.settings"].search([]).length + 1;
    await contains("button[name=action_crm_assign_leads]").click();
    await expect.waitForSteps([
        buttonRoute("res.config.settings", "action_crm_assign_leads"),
        `action_crm_assign_leads [${settingsId}]`,
    ]);
    await contains(`button[name='${PLS_UPDATE_ACTION.id}']`).click();
    await expect.waitForSteps(["/web/action/load"]);
    expect(".modal .o_form_view").toHaveCount(1);
    await cancelDialog();
    await contains("button[name='crm.crm_recurring_plan_action']").click();
    await expect.waitForSteps(["/web/action/load"]);
    await expectCurrentView("crm.crm_recurring_plan_action/list");
});

/** View id of `CRM_SETTINGS_ARCH`, registered for the test that opens it. */
const CRM_SETTINGS_VIEW_ID = 502;

/** Inline app logo of `CRM_SETTINGS_ARCH`, so the settings page loads no image. */
const SETTINGS_APP_LOGO =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z9DwHwAGBQKA3H7sNwAAAABJRU5ErkJggg==";

/**
 * CRM settings (`res_config_settings_view_form` with the CRM inherit) on the real
 * settings view (`js_class="base_settings"`): its controller decides what a button
 * saves, and its model, which reads no cache, reloads the page when a dialog opened
 * from it closes.
 */
const CRM_SETTINGS_ARCH = /* xml */ `
    <form string="Settings" class="oe_form_configuration o_base_settings" js_class="base_settings">
        <app string="CRM" name="crm" logo="${SETTINGS_APP_LOGO}">
            <block title="CRM">
                <setting string="Recurring Revenues">
                    <field name="group_use_recurring_revenues"/>
                    <button type="action" name="crm.crm_recurring_plan_action" string="Recurring Plans" class="btn-link"/>
                </setting>
                <setting string="Predictive Lead Scoring">
                    <button name="${PLS_UPDATE_ACTION.id}" type="action" string="Update Probabilities" class="btn-link"/>
                </setting>
                <setting string="Rule-Based Assignment">
                    <field name="crm_use_auto_assignment"/>
                    <button name="action_crm_assign_leads" type="object" string="Assign now" class="btn-link"/>
                </setting>
            </block>
        </app>
    </form>`;

/**
 * The CRM settings action (`crm.crm_config_settings_action`) on `CRM_SETTINGS_ARCH`.
 * Its id is used by no other action of this file: the mock server merges every
 * action sharing an id into one.
 */
const CRM_BASE_SETTINGS_ACTION = {
    id: 56,
    name: "Settings",
    res_model: "res.config.settings",
    views: [[CRM_SETTINGS_VIEW_ID, "form"]],
    context: { module: "crm", bin_size: false },
};

defineActions([CRM_BASE_SETTINGS_ACTION]);

test("[Offline] CRM settings page closes its dialogs and queues nothing", async () => {
    registerInlineViewArchs("res.config.settings", {
        [`form,${CRM_SETTINGS_VIEW_ID}`]: CRM_SETTINGS_ARCH,
    });
    onRpc("res.config.settings", "execute", ({ args }) => stepServerCall("execute", args[0]));
    const setOffline = mockOffline();
    stepRoutes();
    await mountWithCleanup(WebClient);
    await flushStartupSync();
    await getService("action").doAction(CRM_BASE_SETTINGS_ACTION.id);
    expect(".o-settings-form-view").toHaveCount(1);
    expect.verifySteps([
        "/web/action/load",
        "/web/dataset/call_kw/res.config.settings/get_views",
        "/web/dataset/call_kw/res.config.settings/onchange",
    ]);
    const recurringPlans = "button[name='crm.crm_recurring_plan_action']";
    const update = `button[name='${PLS_UPDATE_ACTION.id}']`;
    const assign = "button[name=action_crm_assign_leads]";
    const save = ".o_control_panel .o_form_button_save";
    const recurringRevenues = ".o_field_widget[name=group_use_recurring_revenues]";

    // Offline, a forced activation of each disabled button stops before the settings
    // record (transient) is saved, unchanged or changed, and so does the control panel
    // Save: no request, nothing queued, no confirmation dialog.
    await setOffline(true);
    for (const selector of [recurringPlans, update, assign, save]) {
        expect(selector).not.toBeEnabled();
        forceClick(selector);
        await settle();
    }
    await contains(`${recurringRevenues} input`).click();
    for (const selector of [recurringPlans, update, assign, save]) {
        forceClick(selector);
        await settle();
    }
    expect(".modal").toHaveCount(0);
    expect(`${recurringRevenues} input`).toBeChecked();
    expect(queued("res.config.settings")).toEqual([]);
    expect.verifySteps([]);
    // Back online, nothing is replayed.
    await reconnect(setOffline);
    expect(queued("res.config.settings")).toEqual([]);
    expect.verifySteps([]);

    // Online, Save applies the changed settings, then reloads the page.
    await contains(save).click();
    await expect.waitForSteps([
        "/web/dataset/call_kw/res.config.settings/web_save",
        buttonRoute("res.config.settings", "execute"),
        "execute [1]",
        "/web/dataset/call_kw/res.config.settings/onchange",
    ]);

    // Online, "Update Probabilities" saves the settings, then opens its wizard.
    await contains(update).click();
    await expect.waitForSteps([
        "/web/dataset/call_kw/res.config.settings/web_save",
        "/web/action/load",
        "/web/dataset/call_kw/crm.lead.pls.update/get_views",
        "/web/dataset/call_kw/crm.lead.pls.update/onchange",
    ]);
    expect(".modal .o_form_view").toHaveCount(1);

    // Offline, the dialog's close control closes it at once: the settings page,
    // which has no cached load, is not reloaded, and stays as it is.
    await setOffline(true);
    await contains(".modal button[aria-label=Close]:visible").click();
    expect(".modal").toHaveCount(0);
    await settle();
    expect(".modal").toHaveCount(0);
    expect(`.o-settings-form-view ${recurringRevenues}`).toHaveCount(1);
    expect(queued("res.config.settings")).toEqual([]);
    expect.verifySteps([]);

    // Online again, every button works. "Assign now" calls its method on the settings
    // record saved before the wizard opened, then reloads the page.
    await reconnect(setOffline);
    expect.verifySteps([]);
    await contains(assign).click();
    await expect.waitForSteps([
        buttonRoute("res.config.settings", "action_crm_assign_leads"),
        "action_crm_assign_leads [2]",
        "/web/dataset/call_kw/res.config.settings/onchange",
    ]);
    // Closing the wizard reloads the settings page, as before (the wizard's views are
    // cached in memory).
    await contains(update).click();
    await expect.waitForSteps([
        "/web/dataset/call_kw/res.config.settings/web_save",
        "/web/action/load",
        "/web/dataset/call_kw/crm.lead.pls.update/onchange",
    ]);
    await contains(".modal button[aria-label=Close]:visible").click();
    await expect.waitForSteps(["/web/dataset/call_kw/res.config.settings/onchange"]);
    expect(".modal").toHaveCount(0);
    await contains(recurringPlans).click();
    await expect.waitForSteps([
        "/web/dataset/call_kw/res.config.settings/web_save",
        "/web/action/load",
        "/web/dataset/call_kw/crm.recurring.plan/get_views",
        "/web/dataset/call_kw/crm.recurring.plan/web_search_read",
        "/web/dataset/call_kw/res.users/has_group",
    ]);
    await expectCurrentView("crm.crm_recurring_plan_action/list");
});

test("[Offline] leaving the changed CRM settings page queues no settings save", async () => {
    // Offline root load served from the cache: the list the settings page goes back to.
    expect.errors(1);
    registerInlineViewArchs("res.config.settings", {
        [`form,${CRM_SETTINGS_VIEW_ID}`]: CRM_SETTINGS_ARCH,
    });
    const setOffline = mockOffline();
    stepRoutes((route) => route === "/web/dataset/call_kw/res.config.settings/web_save");
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    await getService("action").doAction(CRM_BASE_SETTINGS_ACTION.id);
    expect(".o-settings-form-view").toHaveCount(1);

    // Offline, the page is changed, then left through its breadcrumb. Its "Unsaved
    // changes" confirmation, whose buttons are disabled offline, is dismissed: the
    // changes are discarded and the page's save is refused before its request, so
    // nothing is requested or queued, and the page is left.
    await setOffline(true);
    await contains(".o_field_widget[name=group_use_recurring_revenues] input").click();
    await contains(".o_control_panel .breadcrumb-item a, .o_back_button").click();
    expect(".modal .modal-title").toHaveText("Unsaved changes");
    await press("Escape");
    await settle();
    expect(".modal").toHaveCount(0);
    expect(".o_list_view").toHaveCount(1);
    expect.verifyErrors([LEAD_LIST_LOAD]);
    expect.verifySteps([]);
    expect(queued("res.config.settings")).toEqual([]);

    // Back online, nothing is replayed.
    await reconnect(setOffline);
    expect(queued("res.config.settings")).toEqual([]);
    expect.verifySteps([]);
});

/**
 * Captures every form controller set up from now on (wizards, composers and settings
 * included), so a test can reach the real loaded controller of a dialog or page.
 *
 * @returns {FormController[]}
 */
function captureFormControllers() {
    const controllers = [];
    patchWithCleanup(FormController.prototype, {
        setup() {
            super.setup(...arguments);
            controllers.push(this);
        },
    });
    return controllers;
}

test("[Offline] direct save of a CRM wizard or of the CRM settings requests nothing", async () => {
    registerInlineViewArchs("res.config.settings", {
        [`form,${CRM_SETTINGS_VIEW_ID}`]: CRM_SETTINGS_ARCH,
    });
    const controllers = captureFormControllers();
    const setOffline = mockOffline();
    stepRoutes((route) => route.endsWith("/web_save"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    const activeContext = { active_id: 1, active_ids: [1, 2], active_model: "crm.lead" };
    const recurringRevenues = ".o_field_widget[name=group_use_recurring_revenues] input";

    /**
     * The four CRM wizards and the CRM settings page, each opened online with a value
     * entered, and the value its online save writes.
     */
    const targets = [
        {
            action: LOST_ACTION,
            model: "crm.lead.lost",
            enter: () =>
                contains(".modal .o_field_widget[name=lost_feedback] input").edit("Too pricey", {
                    confirm: "blur",
                }),
            expectEntered: () => {
                expect(".modal .o_field_widget[name=lost_feedback] input").toHaveValue("Too pricey");
            },
            saved: { lost_feedback: "Too pricey" },
        },
        {
            action: MASS_CONVERT_ACTION,
            model: "crm.lead2opportunity.partner.mass",
            enter: () => contains(".modal .o_field_widget[name=name] input[data-value=merge]").click(),
            expectEntered: () => {
                expect(".modal .o_field_widget[name=name] input[data-value=merge]").toBeChecked();
            },
            saved: { name: "merge" },
        },
        {
            action: MERGE_ACTION,
            model: "crm.merge.opportunity",
            // The wizard is filled with the selected leads.
            enter: async () => {},
            expectEntered: () => {
                expect(".modal .o_field_widget[name=opportunity_ids] .o_data_row").toHaveCount(2);
            },
            saved: { opportunity_ids: [1, 2] },
        },
        {
            action: PLS_UPDATE_ACTION,
            model: "crm.lead.pls.update",
            enter: () =>
                contains(".modal .o_field_widget[name=pls_start_date] input").edit("2026-01-01", {
                    confirm: "blur",
                }),
            expectEntered: () => {
                expect(".modal .o_field_widget[name=pls_start_date] input").toHaveValue("2026-01-01");
            },
            saved: { pls_start_date: "2026-01-01" },
        },
        {
            action: CRM_BASE_SETTINGS_ACTION,
            model: "res.config.settings",
            enter: () => contains(recurringRevenues).click(),
            expectEntered: () => {
                expect(recurringRevenues).toBeChecked();
            },
            saved: { group_use_recurring_revenues: true },
        },
    ];

    for (const { action, model, enter, expectEntered, saved } of targets) {
        await getService("action").doAction(action.id, { additionalContext: activeContext });
        await enter();
        const controller = controllers.findLast((form) => form.props.resModel === model);
        const { root } = controller.model;
        expect(root.isNew).toBe(true);

        // Offline, the loaded form's own record refuses its save before any request:
        // nothing is requested or queued, and the record keeps what was entered.
        await setOffline(true);
        expect(await root.save()).toBe(false);
        expect(await root.save({ reload: false })).toBe(false);
        // The defence for a save whose request loses the connection still refuses.
        expect(root._offlineSave()).toBe(false);
        await settle();
        expect(root.isNew).toBe(true);
        expectEntered();
        expect(queued(model)).toEqual([]);
        expect.verifySteps([]);

        // Back online, nothing is replayed, and the same save writes the record.
        await reconnect(setOffline);
        expect(queued(model)).toEqual([]);
        expect.verifySteps([]);
        expect(await root.save()).toBe(true);
        expect.verifySteps([`/web/dataset/call_kw/${model}/web_save`]);
        expect(root.isNew).toBe(false);
        expect(MockServer.env[model].browse(root.resId)[0]).toMatchObject(saved);
        if (model !== "res.config.settings") {
            await cancelDialog();
            expect(".modal").toHaveCount(0);
        }
    }
});

/**
 * The mail composer on the real composer view (`js_class="mail_composer_form"`): its
 * Send saves the composer, then calls `action_send_mail`.
 */
const MAIL_COMPOSER_ARCH = /* xml */ `
    <form js_class="mail_composer_form">
        <field name="subject"/>
        <footer>
            <button name="action_send_mail" type="object" string="Send" class="btn-primary" data-hotkey="q"/>
            <button special="cancel" string="Discard"/>
        </footer>
    </form>`;

test("[Offline] mail composer opened online by a CRM action sends and saves nothing", async () => {
    registerInlineViewArchs("mail.compose.message", { "form,false": MAIL_COMPOSER_ARCH });
    onRpc("mail.compose.message", "action_send_mail", ({ args }) =>
        stepServerCall("action_send_mail", args[0])
    );
    const controllers = captureFormControllers();
    const setOffline = mockOffline();
    stepRoutes(
        (route) => route.startsWith("/web/dataset/call_button/") || route.endsWith("/web_save")
    );
    const { env } = await makeMockServer();
    const partnerId = env["res.partner"].create({ name: "Azure Interior" });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    const send = ".modal footer button[name=action_send_mail]";
    const subject = ".modal .o_field_widget[name=subject] input";

    /** The CRM bound composers, opened online the ways CRM screens open them. */
    const openers = [
        // The lead form's "Send email" bound action.
        () =>
            getService("action").doAction(MAIL_COMPOSE_ACTION.id, {
                additionalContext: { active_id: 1, active_ids: [1], active_model: "crm.lead" },
            }),
        // A button naming that action by `xml_id`, here on a partner record.
        () =>
            getService("action").doActionButton({
                type: "action",
                name: MAIL_COMPOSE_ACTION.xml_id,
                resModel: "res.partner",
                resId: partnerId,
                resIds: [partnerId],
                context: {},
                buttonContext: {},
            }),
        // The lead list's "Send email" mass mail bound action.
        () =>
            getService("action").doAction(MASS_MAIL_ACTION.id, {
                additionalContext: { active_ids: [1, 2], active_model: "crm.lead" },
            }),
    ];

    for (const open of openers) {
        // Opened and filled online, then the connection drops.
        await open();
        expect(".modal .o_form_view").toHaveCount(1);
        await contains(subject).edit("Proposal", { confirm: "blur" });
        const controller = controllers.findLast(
            (form) => form.props.resModel === "mail.compose.message"
        );
        expect(controller).toBeInstanceOf(MailComposerFormController);
        await setOffline(true);

        // A forced Send, a direct call of the controller's button entry point and a
        // direct save of its record request nothing and queue nothing; the composer
        // stays, with what was entered.
        expect(send).not.toBeEnabled();
        forceClick(send);
        await settle();
        expect(
            await controller.beforeExecuteActionButton({ name: "action_send_mail", type: "object" })
        ).toBe(false);
        expect(await controller.model.root.save()).toBe(false);
        await settle();
        expect(".modal .o_form_view").toHaveCount(1);
        expect(subject).toHaveValue("Proposal");
        expect(controller.model.root.isNew).toBe(true);
        expect(queued("mail.compose.message")).toEqual([]);
        expect.verifySteps([]);

        // Back online, nothing is replayed, and Send saves the composer and sends.
        await reconnect(setOffline);
        expect(queued("mail.compose.message")).toEqual([]);
        expect.verifySteps([]);
        const composerId = MockServer.env["mail.compose.message"].search([]).length + 1;
        await contains(send).click();
        await expect.waitForSteps([
            "/web/dataset/call_kw/mail.compose.message/web_save",
            buttonRoute("mail.compose.message", "action_send_mail"),
            `action_send_mail [${composerId}]`,
        ]);
        expect(".modal").toHaveCount(0);
        expect(MockServer.env["mail.compose.message"].browse(composerId)[0]).toMatchObject({
            subject: "Proposal",
        });
    }
});

test("[Offline] mail composer of another action keeps the framework offline save", async () => {
    // The Send button's call, attempted offline once the framework has queued the save.
    expect.errors(1);
    registerInlineViewArchs("mail.compose.message", { "form,false": MAIL_COMPOSER_ARCH });
    onRpc("mail.compose.message", "action_send_mail", ({ args }) =>
        stepServerCall("action_send_mail", args[0])
    );
    const setOffline = mockOffline();
    stepRoutes(
        (route) => route.startsWith("/web/dataset/call_button/") || route.endsWith("/web_save")
    );
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    const send = ".modal footer button[name=action_send_mail]";
    const subject = ".modal .o_field_widget[name=subject] input";

    // A composer opened by an action without a CRM `xml_id`, as the chatter opens its
    // full composer.
    await getService("action").doAction({
        type: "ir.actions.act_window",
        res_model: "mail.compose.message",
        target: "new",
        views: [[false, "form"]],
    });
    expect(".modal .o_form_view").toHaveCount(1);
    await contains(subject).edit("Hello", { confirm: "blur" });

    // Offline, a forced Send follows the framework, as before: the save is queued, then
    // the button's call is attempted.
    await setOffline(true);
    forceClick(send);
    await settle();
    expect.verifySteps([
        "/web/dataset/call_kw/mail.compose.message/web_save",
        buttonRoute("mail.compose.message", "action_send_mail"),
    ]);
    expect.verifyErrors([buttonRoute("mail.compose.message", "action_send_mail")]);
    expect(
        queuedCalls("mail.compose.message").map(({ method, args }) => ({ method, args }))
    ).toEqual([{ method: "web_save", args: [[], { subject: "Hello" }] }]);

    // Back online, the framework replays the queued save.
    await reconnect(setOffline);
    expect.verifySteps(["/web/dataset/call_kw/mail.compose.message/web_save"]);
    expect(queued("mail.compose.message")).toEqual([]);
});

/** View id of `GENERAL_SETTINGS_ARCH`, registered for the tests that open it. */
const GENERAL_SETTINGS_VIEW_ID = 506;

/**
 * The General Settings (`base.res_config_settings_view_form` with every app's
 * inherit) on the real settings view: another app's block, then the CRM app as
 * `CRM_SETTINGS_ARCH` shows it.
 */
const GENERAL_SETTINGS_ARCH = /* xml */ `
    <form string="Settings" class="oe_form_configuration o_base_settings" js_class="base_settings">
        <app string="General Settings" name="general_settings" logo="${SETTINGS_APP_LOGO}">
            <block title="Users">
                <setting string="Users">
                    <button name="action_open_users" type="object" string="Manage Users" class="btn-link"/>
                </setting>
            </block>
        </app>
        <app string="CRM" name="crm" logo="${SETTINGS_APP_LOGO}">
            <block title="CRM">
                <setting string="Recurring Revenues">
                    <field name="group_use_recurring_revenues"/>
                    <button type="action" name="crm.crm_recurring_plan_action" string="Recurring Plans" class="btn-link"/>
                </setting>
                <setting string="Predictive Lead Scoring">
                    <button name="${PLS_UPDATE_ACTION.id}" type="action" string="Update Probabilities" class="btn-link"/>
                </setting>
                <setting string="Rule-Based Assignment">
                    <field name="crm_use_auto_assignment"/>
                    <button name="action_crm_assign_leads" type="object" string="Assign now" class="btn-link"/>
                </setting>
            </block>
        </app>
    </form>`;

/**
 * The General Settings action (`base_setup.action_general_configuration`), opened on
 * its own app (`context.module` "general_settings"), on `GENERAL_SETTINGS_ARCH`.
 */
const GENERAL_SETTINGS_ACTION = {
    id: 71,
    xml_id: "base_setup.action_general_configuration",
    name: "Settings",
    res_model: "res.config.settings",
    views: [[GENERAL_SETTINGS_VIEW_ID, "form"]],
    context: { module: "general_settings", bin_size: false },
};

defineActions([GENERAL_SETTINGS_ACTION]);

/**
 * Opens the CRM app of a settings page showing several apps, while online: its side
 * tab, or on a phone the app dropdown, whose toggle is disabled offline.
 */
async function openCrmSettingsApp() {
    if (isSmall()) {
        await contains(".settings_tab .o-dropdown").click();
        await contains(".o-dropdown-item:contains(CRM)").click();
    } else {
        await contains(".settings_tab .tab[data-key=crm]").click();
    }
    expect(".app_settings_block[data-key=crm]").toHaveCount(1);
}

/** Id of the next `res.config.settings` record the mock server creates. */
function nextSettingsId() {
    return MockServer.env["res.config.settings"].search([]).length + 1;
}

test("[Offline] CRM controls of the General Settings request and queue nothing", async () => {
    registerInlineViewArchs("res.config.settings", {
        [`form,${GENERAL_SETTINGS_VIEW_ID}`]: GENERAL_SETTINGS_ARCH,
    });
    onRpc("res.config.settings", "execute", ({ args }) => stepServerCall("execute", args[0]));
    const setOffline = mockOffline();
    // The next settings save loses the connection while its request runs.
    const lostSave = { next: false };
    onRpc("/*", (request) => {
        const route = new URL(request.url).pathname;
        if (lostSave.next && route === "/web/dataset/call_kw/res.config.settings/web_save") {
            lostSave.next = false;
            return new Response("", { status: 502 });
        }
    });
    stepRoutes(
        (route) =>
            route.endsWith("/web_save") ||
            route === "/web/action/load" ||
            route.startsWith("/web/dataset/call_button/")
    );
    await mountWithCleanup(WebClient);
    await flushStartupSync();
    await getService("action").doAction(GENERAL_SETTINGS_ACTION.id);
    expect.verifySteps(["/web/action/load"]);
    expect(".app_settings_block[data-key=general_settings]").toHaveCount(1);
    await openCrmSettingsApp();
    const recurringPlans = "button[name='crm.crm_recurring_plan_action']";
    const update = `button[name='${PLS_UPDATE_ACTION.id}']`;
    const assign = "button[name=action_crm_assign_leads]";
    const recurringRevenues = ".o_field_widget[name=group_use_recurring_revenues] input";
    const generalSettingsView = `${GENERAL_SETTINGS_ACTION.xml_id}/form`;

    // Offline, a forced activation of each CRM control, on the unchanged page then on
    // the changed page, stops before the settings record is saved and before any
    // confirmation opens; so does a direct call of the CRM settings method through
    // the action service: no request, nothing queued, the page stays as it is.
    await setOffline(true);
    for (const selector of [recurringPlans, update, assign]) {
        expect(selector).not.toBeEnabled();
        forceClick(selector);
        await settle();
    }
    expect(".modal").toHaveCount(0);
    await contains(recurringRevenues).click();
    for (const selector of [recurringPlans, update, assign]) {
        forceClick(selector);
        await settle();
    }
    expect(".modal").toHaveCount(0);
    await callButton({
        resModel: "res.config.settings",
        name: "action_crm_assign_leads",
        context: { module: "general_settings" },
    });
    await settle();
    expect(recurringRevenues).toBeChecked();
    expect(currentView()).toBe(generalSettingsView);
    expect(queued("res.config.settings")).toEqual([]);
    expect.verifySteps([]);
    // Back online, nothing is replayed.
    await reconnect(setOffline);
    expect(queued("res.config.settings")).toEqual([]);
    expect.verifySteps([]);

    // A CRM control on the changed page opens the "Unsaved changes" confirmation
    // online; the connection drops, then its disabled Save, or Discard, is forced: no
    // settings save or `execute` is requested or queued, and the control does not run.
    for (const [answer, selector] of [
        ["Save", recurringPlans],
        ["Discard", update],
    ]) {
        expect(recurringRevenues).toBeChecked();
        await contains(selector).click();
        expect(".modal .modal-title").toHaveText("Unsaved changes");
        await setOffline(true);
        forceClick(`.modal footer button:contains(${answer})`);
        await settle();
        expect(".modal").toHaveCount(0);
        expect(currentView()).toBe(generalSettingsView);
        expect(queued("res.config.settings")).toEqual([]);
        expect.verifySteps([]);
        await reconnect(setOffline);
        expect(queued("res.config.settings")).toEqual([]);
        expect.verifySteps([]);
    }
    // Discard reverted the change.
    expect(recurringRevenues).not.toBeChecked();

    // Online, the connection is lost while a CRM control's settings save runs: the
    // save is not queued, and the control does not run.
    lostSave.next = true;
    await contains(assign).click();
    await settle();
    expect.verifySteps(["/web/dataset/call_kw/res.config.settings/web_save"]);
    expect(queued("res.config.settings")).toEqual([]);
    await reconnect(setOffline);
    expect(queued("res.config.settings")).toEqual([]);
    expect.verifySteps([]);

    // Online, each CRM control works as before: it saves the settings, then runs.
    let settingsId = nextSettingsId();
    await contains(assign).click();
    await expect.waitForSteps([
        "/web/dataset/call_kw/res.config.settings/web_save",
        buttonRoute("res.config.settings", "action_crm_assign_leads"),
        `action_crm_assign_leads [${settingsId}]`,
    ]);
    await contains(update).click();
    await expect.waitForSteps([
        "/web/dataset/call_kw/res.config.settings/web_save",
        "/web/action/load",
    ]);
    expect(".modal .o_form_view").toHaveCount(1);
    await contains(".modal button[aria-label=Close]:visible").click();
    expect(".modal").toHaveCount(0);
    // On the changed page, the confirmation's Save applies the settings, and the
    // control does not run.
    await contains(recurringRevenues).click();
    await contains(recurringPlans).click();
    expect(".modal .modal-title").toHaveText("Unsaved changes");
    settingsId = nextSettingsId();
    await contains(".modal footer .btn-primary").click();
    await expect.waitForSteps([
        "/web/dataset/call_kw/res.config.settings/web_save",
        buttonRoute("res.config.settings", "execute"),
        `execute [${settingsId}]`,
    ]);
    expect(".modal").toHaveCount(0);
    expect(currentView()).toBe(generalSettingsView);
    await contains(recurringPlans).click();
    await expect.waitForSteps([
        "/web/dataset/call_kw/res.config.settings/web_save",
        "/web/action/load",
    ]);
    await expectCurrentView("crm.crm_recurring_plan_action/list");
    expect(queued("res.config.settings")).toEqual([]);
});

test("[Offline] other apps' controls of the General Settings keep their behaviour", async () => {
    // The other app's button call, attempted offline once the framework has queued
    // the settings save.
    expect.errors(1);
    registerInlineViewArchs("res.config.settings", {
        [`form,${GENERAL_SETTINGS_VIEW_ID}`]: GENERAL_SETTINGS_ARCH,
    });
    onRpc("res.config.settings", "action_open_users", ({ args }) =>
        stepServerCall("action_open_users", args[0])
    );
    const setOffline = mockOffline();
    stepRoutes(
        (route) => route.endsWith("/web_save") || route.startsWith("/web/dataset/call_button/")
    );
    await mountWithCleanup(WebClient);
    await flushStartupSync();
    await getService("action").doAction(GENERAL_SETTINGS_ACTION.id);
    const manageUsers = "button[name=action_open_users]";

    // Online, the button saves the settings, then calls its method.
    const settingsId = nextSettingsId();
    await contains(manageUsers).click();
    await expect.waitForSteps([
        "/web/dataset/call_kw/res.config.settings/web_save",
        buttonRoute("res.config.settings", "action_open_users"),
        `action_open_users [${settingsId}]`,
    ]);

    // Offline, a forced activation follows the framework, as before: the settings
    // save is queued, then the button's call is attempted.
    await setOffline(true);
    forceClick(manageUsers);
    await settle();
    expect.verifySteps([
        "/web/dataset/call_kw/res.config.settings/web_save",
        buttonRoute("res.config.settings", "action_open_users"),
    ]);
    expect.verifyErrors([buttonRoute("res.config.settings", "action_open_users")]);
    expect(queuedCalls("res.config.settings").map(({ method }) => method)).toEqual(["web_save"]);

    // Back online, the framework replays the queued save.
    await reconnect(setOffline);
    expect.verifySteps(["/web/dataset/call_kw/res.config.settings/web_save"]);
    expect(queued("res.config.settings")).toEqual([]);
});


/** Closes every open dropdown (Escape), whatever closed or kept them open before. */
async function closeOpenDropdowns() {
    if (queryAll(".o-dropdown--menu").length) {
        await press("Escape");
        await animationFrame();
    }
    expect(".o-dropdown--menu").toHaveCount(0);
}

/** The seven `type="action"` links of the Sales Teams dashboard card menu. */
const TEAM_MENU_LINKS = [
    TEAM_LEADS_ACTION_ID,
    TEAM_PIPELINE_ACTION_ID,
    NEW_LEAD_ACTION_ID,
    NEW_OPPORTUNITY_ACTION_ID,
    LEAD_SALESTEAM_REPORT_ACTION_ID,
    TEAM_REPORT_ACTION_ID,
    ACTIVITY_REPORT_TEAM_ACTION_ID,
].map((id) => ({ id, selector: `.o-dropdown--menu a[name='${id}'][type=action]` }));

test("[Offline] sales team dashboard controls are unreachable", async () => {
    /** The mounted team-leader fields (`KanbanMany2One`) of the dashboard cards. */
    const leaderFields = new Set();
    patchWithCleanup(KanbanMany2One.prototype, {
        setup() {
            super.setup(...arguments);
            leaderFields.add(this);
            onWillDestroy(() => leaderFields.delete(this));
        },
    });
    onRpc("crm.team", "web_save", ({ args }) => {
        expect.step({ web_save: args });
    });
    const setOffline = mockOffline();
    stepRoutes(
        (route) => route === "/web/action/load" || route.startsWith("/web/dataset/call_button/")
    );
    await mountWithCleanup(WebClient);
    await getService("action").doAction(TEAM_ACTION.id);
    // Europe's team form is visited online, so the framework no longer dims its card
    // offline by itself; America's is not.
    await getService("action").switchView("form", { resId: 1 });
    await goBack();
    await flushStartupSync();
    expect.verifySteps(["/web/action/load"]);
    const unassigned = `${EUROPE_CARD} a[name=action_open_unassigned_opportunities]`;
    expectUnguarded(unassigned, 1);
    const teamCards = ".o_kanban_record:not(.o_kanban_ghost)";
    expect(teamCards).toHaveCount(2);
    for (const card of queryAll(teamCards)) {
        expect(card).not.toHaveClass("o_disabled_offline");
    }

    // Team-leader quick-assign (no leader set): an assign popover opened online closes
    // when the connection drops.
    const quickAssign = `${EUROPE_CARD} a.o_quick_assign`;
    const assignPopover = ".o_m2o_tags_avatar_field_popover";
    expect(`${teamCards} a.o_quick_assign`).toHaveCount(2);
    expect(leaderFields.size).toBe(2);
    expect(quickAssign).not.toHaveClass("o_disabled_offline");
    expect(quickAssign).not.toHaveAttribute("aria-disabled");
    expect(quickAssign).toHaveAttribute("tabindex", "-1");
    await contains(quickAssign).click();
    expect(assignPopover).toHaveCount(1);
    await setOffline(true);
    await animationFrame();
    expect(assignPopover).toHaveCount(0);
    // Offline, every card is dimmed once, whether or not its team form was visited
    // online: its click (the kanban root action) is inert.
    expect(getService(OfflinePlugin).isAvailableOffline(TEAM_ACTION.id, "form", 1)).toBe(true);
    expect(getService(OfflinePlugin).isAvailableOffline(TEAM_ACTION.id, "form", 2)).toBe(false);
    for (const card of queryAll(teamCards)) {
        expect(card.className.split(" ").filter((name) => name === "o_disabled_offline")).toEqual([
            "o_disabled_offline",
        ]);
    }
    // The quick-assign of every card is disabled, out of the tab order and of
    // hit-testing (a pointer reaches the inert card), and inert by pointer, keyboard
    // and a direct call: no popover, no queued team write.
    const tabbable = getFocusableElements({ tabbable: true });
    for (const link of queryAll(`${teamCards} a.o_quick_assign`)) {
        expect(link).toHaveClass(["o_disabled_offline", "pe-none"]);
        expect(link).toHaveStyle({ "pointer-events": "none" });
        expect(link).toHaveAttribute("aria-disabled", "true");
        expect(link).toHaveAttribute("tabindex", "-1");
        expect(tabbable).not.toInclude(link);
    }
    await activateByPointerAndKeyboard(`${teamCards} a.o_quick_assign`);
    for (const leaderField of leaderFields) {
        leaderField.openAssignPopover(queryFirst(quickAssign));
    }
    await settle();
    expect(assignPopover).toHaveCount(0);
    expect(currentView()).toBe("sales_team.crm_team_action_pipeline/kanban");
    expect(queued("crm.team")).toEqual([]);
    // Back online, the cards and the quick-assign are as the framework renders them.
    await setOffline(false);
    await animationFrame();
    for (const card of queryAll(teamCards)) {
        expect(card).not.toHaveClass("o_disabled_offline");
    }
    expect(quickAssign).not.toHaveClass("o_disabled_offline");
    expect(quickAssign).not.toHaveClass("pe-none");
    expect(quickAssign).toHaveStyle({ "pointer-events": "auto" });
    expect(quickAssign).not.toHaveAttribute("aria-disabled");
    expect(quickAssign).toHaveAttribute("tabindex", "-1");
    expect.verifySteps([]);

    // A card menu opened online keeps its links, which become inert offline. Each
    // link gets its own menu: activating one may close the menu, and the toggle
    // cannot reopen it offline.
    for (const { selector } of TEAM_MENU_LINKS) {
        await closeOpenDropdowns();
        await contains(EUROPE_MENU_TOGGLE, { visible: false }).click();
        expectUnguarded(selector, 1);
        await setOffline(true);
        expectGuarded(selector, 1);
        await activateByPointerAndKeyboard(selector);
        await settle();
        expect(currentView()).toBe("sales_team.crm_team_action_pipeline/kanban");
        await setOffline(false);
        await animationFrame();
    }
    expect.verifySteps([]);
    // Closed, the card menu cannot be opened again offline.
    await closeOpenDropdowns();
    await setOffline(true);
    expect(EUROPE_MENU_TOGGLE).not.toBeEnabled();
    await click(queryFirst(EUROPE_MENU_TOGGLE));
    await animationFrame();
    expect(".o-dropdown--menu a[type=action]").toHaveCount(0);
    // The card click (kanban root action) and the unassigned-leads link are inert.
    expectGuarded(unassigned, 1);
    await activateByPointerAndKeyboard(unassigned);
    await contains(`${EUROPE_CARD} span.fw-bold`).click();
    // Direct calls of the button boundary: the card action, the link, the menu links.
    for (const name of ["action_primary_channel_button", "action_open_unassigned_opportunities"]) {
        await callButton({ resModel: "crm.team", name, resId: 1 });
    }
    for (const { id } of TEAM_MENU_LINKS) {
        await callButton({ resModel: "crm.team", name: `${id}`, resId: 1, type: "action" });
    }
    await settle();
    expect(currentView()).toBe("sales_team.crm_team_action_pipeline/kanban");
    expect(".modal").toHaveCount(0);
    expect(queued("crm.team")).toEqual([]);
    expect.verifySteps([]);

    // Online: the card click, the link and every menu link open their target.
    await setOffline(false);
    await animationFrame();
    expectUnguarded(unassigned, 1);
    await contains(`${EUROPE_CARD} span.fw-bold`).click();
    await expect.waitForSteps([
        buttonRoute("crm.team", "action_primary_channel_button"),
        "crm.team.action_primary_channel_button",
    ]);
    await contains(unassigned).click();
    await expect.waitForSteps([
        buttonRoute("crm.team", "action_open_unassigned_opportunities"),
        "crm.team.action_open_unassigned_opportunities",
    ]);
    for (const { id, selector } of TEAM_MENU_LINKS) {
        await contains(EUROPE_MENU_TOGGLE, { visible: false }).click();
        await contains(selector).click();
        await expect.waitForSteps(["/web/action/load"]);
        await expectCurrentView(
            `${[TEAM_LEADS_ACTION, TEAM_PIPELINE_ACTION, NEW_LEAD_ACTION, NEW_OPPORTUNITY_ACTION, LEAD_SALESTEAM_REPORT_ACTION, TEAM_REPORT_ACTION, ACTIVITY_REPORT_TEAM_ACTION].find((action) => action.id === id).xml_id}/${{ [TEAM_LEADS_ACTION_ID]: "list", [TEAM_PIPELINE_ACTION_ID]: "kanban", [NEW_LEAD_ACTION_ID]: "form", [NEW_OPPORTUNITY_ACTION_ID]: "form", [LEAD_SALESTEAM_REPORT_ACTION_ID]: "graph", [TEAM_REPORT_ACTION_ID]: "pivot", [ACTIVITY_REPORT_TEAM_ACTION_ID]: "graph" }[id]}`
        );
        await goBack();
        await expectCurrentView("sales_team.crm_team_action_pipeline/kanban");
    }

    // Online, the quick-assign sets the team leader.
    expect(quickAssign).not.toHaveClass("o_disabled_offline");
    expect(quickAssign).not.toHaveAttribute("aria-disabled");
    await contains(quickAssign).click();
    await contains(`${assignPopover} .o-autocomplete--dropdown-item:first`).click();
    await expect.waitForSteps([{ web_save: [[1], { user_id: serverState.userId }] }]);
    expect(assignPopover).toHaveCount(0);
    expect(quickAssign).toHaveCount(0);
    const leaderAvatar = `${EUROPE_CARD} .o_m2o_avatar > img`;
    expect(leaderAvatar).toHaveCount(1);
    expect(queued("crm.team")).toEqual([]);
    if (isSmall()) {
        // Avatars open no contact card on a small screen, online or offline.
        return;
    }

    // The leader's avatar: offline it opens no contact card, so its read is neither
    // issued nor raised; online the card opens and reads the leader.
    onRpc("/mail/store", async (request) => {
        const { params } = await request.json();
        if (JSON.stringify(params.fetch_params).includes("avatar_card")) {
            expect.step("avatar_card");
        }
    });
    await setOffline(true);
    await click(queryFirst(leaderAvatar));
    await settle();
    expect(".o_avatar_card").toHaveCount(0);
    expect.verifySteps([]);
    await setOffline(false);
    await animationFrame();
    await click(queryFirst(leaderAvatar));
    await settle();
    await expect.waitForSteps(["avatar_card"]);
    expect(".o_avatar_card").toHaveCount(1);
});

// Refine D2.3 (U3): the avatar-card read of lead avatars (SKIP).

/** Pipeline kanban arch (`crm_case_kanban_view_leads`) with the card's salesperson avatar. */
const LEAD_AVATAR_KANBAN_ARCH = /* xml */ `
    <kanban js_class="crm_mobile_pipeline" default_group_by="stage_id" archivable="false">
        <field name="stage_id"/>
        <field name="active"/>
        <field name="won_status"/>
        <templates>
            <t t-name="card">
                <field class="fw-bold fs-5" name="name"/>
                <footer class="pt-1">
                    <field name="user_id" widget="many2one_avatar_user" class="ms-2"/>
                </footer>
            </t>
        </templates>
    </kanban>`;

/** Opportunities list arch (`crm_case_tree_view_oppor`) with its salesperson column. */
const LEAD_AVATAR_LIST_ARCH = /* xml */ `
    <list string="Opportunities" js_class="crm_list" multi_edit="1">
        <field name="name"/>
        <field name="user_id" widget="many2one_avatar_user"/>
    </list>`;

/** Lead form arch (`crm_lead_view_form`) with its salesperson field. */
const LEAD_AVATAR_FORM_ARCH = /* xml */ `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="team_id"/>
            <field name="user_id" widget="many2one_avatar_leader_user" teamField="team_id"/>
        </sheet>
    </form>`;

/**
 * Merge wizard arch (`merge_opportunity_form`) restricted to its lead list: the view's
 * root is the wizard, the avatars belong to the listed leads.
 */
const MERGE_WIZARD_AVATAR_ARCH = /* xml */ `
    <form string="Merge Leads/Opportunities">
        <field name="opportunity_ids" nolabel="1">
            <list>
                <field name="name" string="Title"/>
                <field name="user_id" widget="many2one_avatar_user"/>
            </list>
        </field>
    </form>`;

/**
 * Steps every avatar-card contact read (`/mail/store` with an `avatar_card` fetch)
 * that leaves the client. Must be called after `mockOffline()`: the listener
 * registered last runs first, so it also sees the offline attempts.
 */
function stepAvatarCardReads() {
    onRpc("/mail/store", async (request) => {
        const { params } = await request.json();
        if (JSON.stringify(params.fetch_params).includes("avatar_card")) {
            expect.step("avatar_card");
        }
    });
}

/** The mounted `Avatar` components, so their click handler can be called directly. */
function captureAvatars() {
    const avatars = new Set();
    patchWithCleanup(Avatar.prototype, {
        setup() {
            super.setup(...arguments);
            avatars.add(this);
            onWillDestroy(() => avatars.delete(this));
        },
    });
    return avatars;
}

/**
 * The avatar-card cycle of the lead avatars of a mounted view (`avatarImg` selects
 * their `<img>`). Offline, neither a click nor a direct `onClickAvatar` call opens a
 * card, and no read is issued, queued or raised. Online, the click opens the card,
 * which reads the user once; when the connection drops again, that card stays open
 * with what it loaded and reads nothing more.
 *
 * @param {(offline: boolean) => Promise<void>} setOffline
 * @param {string} avatarImg
 * @param {Set<Avatar>} avatars
 */
async function expectLeadAvatarCardSkippedOffline(setOffline, avatarImg, avatars) {
    expect(avatars.size).toBeGreaterThan(0);
    expect.verifySteps([]);

    await setOffline(true);
    await click(queryFirst(avatarImg));
    await settle();
    expect(".o_avatar_card").toHaveCount(0);
    for (const avatar of avatars) {
        expect(avatar.canOpenPopover).toBe(false);
        avatar.onClickAvatar({ currentTarget: queryFirst(avatarImg) });
    }
    await settle();
    expect(".o_avatar_card").toHaveCount(0);
    expect.verifySteps([]);
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);

    await setOffline(false);
    await animationFrame();
    for (const avatar of avatars) {
        expect(avatar.canOpenPopover).toBe(true);
    }
    await click(queryFirst(avatarImg));
    await expect.waitForSteps(["avatar_card"]);
    await waitFor(".o_avatar_card .o-mail-avatar-card-name");
    expect(".o_avatar_card").toHaveCount(1);
    const loadedName = queryFirst(".o_avatar_card .o-mail-avatar-card-name").textContent;
    expect(loadedName).toBe(serverState.partnerName);

    await setOffline(true);
    await animationFrame();
    expect(".o_avatar_card").toHaveCount(1);
    expect(".o_avatar_card .o-mail-avatar-card-name").toHaveText(loadedName);
    expect.verifySteps([]);
}

test.tags("desktop");
test("[Offline] pipeline card salesperson avatar opens no avatar card", async () => {
    const avatars = captureAvatars();
    const setOffline = mockOffline();
    stepAvatarCardReads();
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        arch: LEAD_AVATAR_KANBAN_ARCH,
        groupBy: ["stage_id"],
        config: { actionId: 1 },
    });
    await flushStartupSync();
    // Every lead with a salesperson shows its avatar (Lead 5 has none).
    expect(".o_kanban_record .o_m2o_avatar > img").toHaveCount(4);

    await expectLeadAvatarCardSkippedOffline(
        setOffline,
        ".o_kanban_record:contains(Lead 1) .o_m2o_avatar > img",
        avatars
    );
});

test.tags("desktop");
test("[Offline] lead list salesperson avatar opens no avatar card", async () => {
    const avatars = captureAvatars();
    const setOffline = mockOffline();
    stepAvatarCardReads();
    await mountView({
        type: "list",
        resModel: "crm.lead",
        arch: LEAD_AVATAR_LIST_ARCH,
        config: { actionId: 1 },
    });
    await flushStartupSync();
    expect(".o_data_row .o_m2o_avatar > img").toHaveCount(4);

    await expectLeadAvatarCardSkippedOffline(
        setOffline,
        ".o_data_row:contains(Lead 1) .o_m2o_avatar > img",
        avatars
    );
    // The avatar's click neither selected nor opened the row.
    expect(".o_data_row .o_list_record_selector input:checked").toHaveCount(0);
    expect(".o_data_row").toHaveCount(5);
});

test.tags("desktop");
test("[Offline] lead form salesperson avatar opens no avatar card", async () => {
    const avatars = captureAvatars();
    const setOffline = mockOffline();
    stepAvatarCardReads();
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        arch: LEAD_AVATAR_FORM_ARCH,
        config: { actionId: 1 },
    });
    await flushStartupSync();
    expect(".o_field_widget[name=user_id] .o_m2o_avatar > img").toHaveCount(1);

    await expectLeadAvatarCardSkippedOffline(
        setOffline,
        ".o_field_widget[name=user_id] .o_m2o_avatar > img",
        avatars
    );
});

test.tags("desktop");
test("[Offline] lead avatars of a wizard's lead list open no avatar card", async () => {
    const avatars = captureAvatars();
    const setOffline = mockOffline();
    stepAvatarCardReads();
    const { env } = await makeMockServer();
    const wizardId = env["crm.merge.opportunity"].create({ opportunity_ids: [1, 2] });
    await mountView({
        type: "form",
        resModel: "crm.merge.opportunity",
        resId: wizardId,
        arch: MERGE_WIZARD_AVATAR_ARCH,
    });
    await flushStartupSync();
    expect(".o_field_widget[name=opportunity_ids] .o_data_row .o_m2o_avatar > img").toHaveCount(2);

    await expectLeadAvatarCardSkippedOffline(
        setOffline,
        ".o_field_widget[name=opportunity_ids] .o_data_row:contains(Lead 1) .o_m2o_avatar > img",
        avatars
    );
});

test.tags("desktop");
test("[Offline] avatars of other models keep opening their card", async () => {
    const avatars = captureAvatars();
    const setOffline = mockOffline();
    stepAvatarCardReads();
    const { env } = await makeMockServer();
    const recordId = env["m2x.avatar.user"].create({ user_id: serverState.userId });
    await mountView({
        type: "form",
        resModel: "m2x.avatar.user",
        resId: recordId,
        arch: /* xml */ `<form><field name="user_id" widget="many2one_avatar_user"/></form>`,
    });
    await flushStartupSync();
    expect(avatars.size).toBe(1);
    const [avatar] = avatars;

    // Offline, the CRM guard leaves the avatar as the framework renders it.
    await setOffline(true);
    expect(avatar.crmOfflineAvatarGuarded).toBe(false);
    expect(avatar.canOpenPopover).toBe(true);
    await setOffline(false);
    await animationFrame();
    await click(".o_field_widget[name=user_id] .o_m2o_avatar > img");
    await expect.waitForSteps(["avatar_card"]);
    await waitFor(".o_avatar_card");
    expect(".o_avatar_card").toHaveCount(1);
});

test("[Offline] team configuration link inert in a menu opened online", async () => {
    let europeCard = null;
    patchWithCleanup(KanbanRecord.prototype, {
        setup() {
            super.setup(...arguments);
            if (this.props.record.resModel === "crm.team" && this.props.record.resId === 1) {
                europeCard = this;
            }
        },
    });
    const setOffline = mockOffline();
    stepRoutes((route) => route.includes("/crm.team/"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(TEAM_ACTION.id);
    await flushStartupSync();
    expect.verifySteps([
        "/web/dataset/call_kw/crm.team/get_views",
        "/web/dataset/call_kw/crm.team/web_search_read",
    ]);
    const configuration = ".o-dropdown--menu a.dropdown-item:contains(Configuration)";
    /** Asserts that "Configuration" is not the menu's focused or active item. */
    const expectConfigurationNotNavigated = () => {
        expect(configuration).not.toBeFocused();
        expect(configuration).not.toHaveClass("focus");
        expect(configuration).not.toHaveAttribute("aria-selected", "true");
    };

    // The manager opens the card menu online: "Configuration" is a plain link, which
    // the dropdown's keyboard navigation reaches.
    await contains(EUROPE_MENU_TOGGLE, { visible: false }).click();
    expect(configuration).not.toHaveClass("o_disabled_offline");
    expect(configuration).not.toHaveAttribute("aria-disabled");
    expect(configuration).not.toHaveAttribute("tabindex");
    expect(configuration).not.toHaveAttribute("inert");
    expect(configuration).toHaveClass("o-navigable");
    await press("Tab");
    await animationFrame();
    expect(configuration).toBeFocused();
    expect(configuration).toHaveClass("focus");
    expect(configuration).toHaveAttribute("aria-selected", "true");

    // The connection drops: "Configuration" is disabled, out of the tab order and
    // inert, while the colour picker beside it stays usable.
    await setOffline(true);
    expect(configuration).toHaveClass(["o_disabled_offline", "pe-none"]);
    expect(configuration).toHaveAttribute("aria-disabled", "true");
    expect(configuration).toHaveAttribute("tabindex", "-1");
    expect(getFocusableElements({ tabbable: true })).not.toInclude(queryFirst(configuration));
    // It also leaves the dropdown's own keyboard navigation (which ignores tabindex),
    // and the focus it had online: no key of the open menu reaches it.
    expect(configuration).toHaveAttribute("inert");
    expect(configuration).not.toHaveClass("o-navigable");
    expectConfigurationNotNavigated();
    for (const keys of ["Tab", "Tab", ["Shift", "Tab"], "ArrowDown", "ArrowUp", "Home", "End"]) {
        await press(keys);
        await animationFrame();
        expectConfigurationNotNavigated();
    }
    const colours = ".o-dropdown--menu .o_kanban_colorpicker button";
    expect(colours).toHaveCount(12);
    for (const colour of queryAll(colours)) {
        expect(colour).toHaveAttribute("data-available-offline", "1");
        expect(colour).toBeEnabled();
    }

    // Back online, in the same open menu: "Configuration" is a plain link again,
    // which the keyboard navigation reaches.
    await setOffline(false);
    expect(configuration).not.toHaveClass("o_disabled_offline");
    expect(configuration).not.toHaveClass("pe-none");
    expect(configuration).not.toHaveAttribute("aria-disabled");
    expect(configuration).not.toHaveAttribute("tabindex");
    expect(configuration).not.toHaveAttribute("inert");
    expect(configuration).toHaveClass("o-navigable");
    await press("Tab");
    await animationFrame();
    expect(configuration).toBeFocused();
    expect(configuration).toHaveClass("focus");

    // Disconnected again, still in that menu: focus, click, Enter and the card's
    // open/edit trigger are inert.
    await setOffline(true);
    expect(configuration).toHaveAttribute("inert");
    expectConfigurationNotNavigated();
    queryFirst(configuration).focus();
    expect(configuration).not.toBeFocused();
    await press("Enter");
    await settle();
    expect(currentView()).toBe("sales_team.crm_team_action_pipeline/kanban");
    // A pointer click on the link lands on its menu cell (the link takes none), and a
    // script's click reaches the link itself: none opens anything or closes the menu,
    // which could not be reopened offline.
    expect(configuration).toHaveCount(1);
    const configurationCell = queryFirst(configuration).parentElement;
    expect(configurationCell).toHaveAttribute("role", "menuitem");
    await click(queryFirst(configuration));
    await settle();
    expect(".o-dropdown--menu").toHaveCount(1);
    await click(configurationCell);
    await settle();
    expect(".o-dropdown--menu").toHaveCount(1);
    const scriptClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    queryFirst(configuration).dispatchEvent(scriptClick);
    // Its `href="#"` is not followed either.
    expect(scriptClick.defaultPrevented).toBe(true);
    await settle();
    expect(".o-dropdown--menu").toHaveCount(1);
    expect(configuration).toHaveCount(1);
    expect(currentView()).toBe("sales_team.crm_team_action_pipeline/kanban");
    // Direct calls of the card's open/edit trigger.
    await europeCard.triggerAction({ type: "open" });
    await europeCard.triggerAction({ type: "edit" });
    await settle();
    expect(currentView()).toBe("sales_team.crm_team_action_pipeline/kanban");
    expect(".o_form_view").toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);

    // The menu's colour picker is still usable: the colour is queued, which closes
    // the menu as any colour pick does, and replays on reconnection.
    expect(colours).toHaveCount(12);
    await contains(".o-dropdown--menu .o_colorlist_item_color_6").click();
    expect(".o-dropdown--menu").toHaveCount(0);
    expect(EUROPE_CARD).toHaveClass("o_kanban_color_6");
    expect(queuedCalls("crm.team")).toEqual([
        {
            model: "crm.team",
            method: "web_save",
            args: [[1], { color: 6 }],
            kwargs: { context: queuedContext(), specification: {} },
        },
    ]);
    // The offline attempt of the save, which the framework then queued.
    expect.verifySteps(["/web/dataset/call_kw/crm.team/web_save"]);
    await reconnect(setOffline);
    await expect.waitForSteps(["/web/dataset/call_kw/crm.team/web_save"]);
    expect(queued("crm.team")).toEqual([]);
    expect(MockServer.env["crm.team"].browse(1)[0].color).toBe(6);

    // Online, "Configuration" opens the team form.
    await setOffline(false);
    await animationFrame();
    await contains(EUROPE_MENU_TOGGLE, { visible: false }).click();
    expect(configuration).not.toHaveClass("o_disabled_offline");
    await contains(configuration).click();
    await expectCurrentView("sales_team.crm_team_action_pipeline/form");
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Europe");
    expect.verifySteps(["/web/dataset/call_kw/crm.team/web_read"]);
});

test("[Offline] team form multi-membership skips the manager probe", async () => {
    let teamController = null;
    patchWithCleanup(registry.category("views").get("crm_team_form").Controller.prototype, {
        setup() {
            super.setup(...arguments);
            teamController = this;
        },
    });
    // The form controller's own boundary, which saves the record before every button
    // but `special="cancel"`: steps the special buttons that reach it.
    patchWithCleanup(FormController.prototype, {
        beforeExecuteActionButton(clickParams) {
            if (clickParams?.special) {
                expect.step(`form controller special ${clickParams.special}`);
            }
            return super.beforeExecuteActionButton(...arguments);
        },
    });
    patchWithCleanup(user, {
        hasGroup(group) {
            if (group === "sales_team.group_sale_manager") {
                expect.step(`hasGroup ${group}`);
                return Promise.resolve(true);
            }
            return super.hasGroup(...arguments);
        },
    });
    onRpc("ir.config_parameter", "set_bool", ({ args }) => {
        expect.step(`set_bool ${JSON.stringify(args)}`);
        return true;
    });
    const setOffline = mockOffline();
    stepRoutes(
        (route) =>
            route.startsWith("/web/dataset/call_button/") ||
            route.includes("/ir.config_parameter/") ||
            route === "/web/dataset/call_kw/crm.team/web_save"
    );
    await mountWithCleanup(WebClient);
    await getService("action").doAction({
        type: "ir.actions.act_window",
        res_model: "crm.team",
        res_id: 1,
        views: [[false, "form"]],
    });
    await flushStartupSync();
    const alert = ".o_form_view .alert.alert-info";
    const activate = `${alert} button[name=crm_team_activate_multi_membership]`;
    const assignLeads = ".o_statusbar_buttons button[name=action_assign_leads]";
    const opportunities = "button[name=action_open_opportunities]";
    const nameInput = ".o_form_view .o_field_widget[name=name] input";
    expect(alert).toHaveCount(1);
    expect(alert).not.toHaveClass("d-none");
    // An unsaved edit of the team, made online.
    await contains(nameInput).edit("Europe (unsaved)");
    expect(await teamController.model.root.isDirty()).toBe(true);

    await setOffline(true);
    // The direct boundary call is refused before the probe and the write.
    const clickParams = { name: "crm_team_activate_multi_membership", type: "button" };
    expect(await teamController.beforeExecuteActionButton(clickParams)).toBe(false);
    // Neither pointer nor keyboard activation probes the group or writes the parameter.
    await activateByPointerAndKeyboard(activate);
    await settle();
    expect(alert).toHaveCount(1);
    expect(alert).not.toHaveClass("d-none");
    // The team form's server-side buttons are guarded and inert.
    for (const selector of [assignLeads, opportunities]) {
        await revealFormControl(selector);
        expectGuarded(selector, 1);
        await activateByPointerAndKeyboard(selector);
    }
    for (const name of ["action_assign_leads", "action_open_opportunities"]) {
        await callButton({ resModel: "crm.team", name, resId: 1 });
    }
    // The team form refuses its object and action buttons before the form controller
    // saves the record ahead of them: the unsaved edit is neither saved nor queued.
    for (const params of [
        { name: "action_assign_leads", type: "object" },
        { name: "action_open_opportunities", type: "object" },
        { name: `${TEAM_PIPELINE_ACTION_ID}`, type: "action" },
    ]) {
        expect(await teamController.beforeExecuteActionButton(params)).toBe(false);
    }
    // A special button is not refused: it reaches the form controller's boundary,
    // which saves nothing for "cancel".
    expect(await teamController.beforeExecuteActionButton({ special: "cancel" })).toBe(undefined);
    expect.verifySteps(["form controller special cancel"]);
    await settle();
    expect(".modal").toHaveCount(0);
    expect(getService("action").currentController.action.res_model).toBe("crm.team");
    expect(nameInput).toHaveValue("Europe (unsaved)");
    expect(await teamController.model.root.isDirty()).toBe(true);
    expect(MockServer.env["crm.team"].browse(1)[0].name).toBe("Europe");
    expect(queued("crm.team")).toEqual([]);
    expect(queued("ir.config_parameter")).toEqual([]);
    expect.verifySteps([]);

    // Online: the probe runs, then the parameter is written and the alert hides.
    await setOffline(false);
    await animationFrame();
    await contains(activate).click();
    await expect.waitForSteps([
        "hasGroup sales_team.group_sale_manager",
        "/web/dataset/call_kw/ir.config_parameter/set_bool",
        'set_bool ["sales_team.membership_multi",true]',
    ]);
    expect(alert).toHaveClass("d-none");
    await revealFormControl(opportunities);
    expectUnguarded(opportunities, 1);
    await contains(opportunities).click();
    // Online, the button saves the unsaved edit first, then runs.
    await expect.waitForSteps([
        "/web/dataset/call_kw/crm.team/web_save",
        buttonRoute("crm.team", "action_open_opportunities"),
        "action_open_opportunities [1]",
    ]);
    expect(MockServer.env["crm.team"].browse(1)[0].name).toBe("Europe (unsaved)");
    expectUnguarded(assignLeads, 1);
    await contains(assignLeads).click();
    await contains(".modal-footer .btn-primary:contains(Assign Leads)").click();
    await expect.waitForSteps([
        buttonRoute("crm.team", "action_assign_leads"),
        "action_assign_leads [1]",
    ]);
});

test("[Offline] lead generation dropdown disabled, no module lookup or access probe", async () => {
    let dropdown = null;
    patchWithCleanup(LeadGenerationDropdown.prototype, {
        setup() {
            super.setup(...arguments);
            dropdown = this;
        },
    });
    const setOffline = mockOffline();
    stepRoutes(
        (route) =>
            route === "/web/action/load" ||
            route.includes("/ir.module.module/") ||
            route.includes("/base.module.install.request/") ||
            route.endsWith("/has_access") ||
            route.endsWith("/check_access_rights")
    );
    await mountWithCleanup(WebClient);
    await getService("action").doAction(PIPELINE_ACTION.id);
    await flushStartupSync();
    expect.verifySteps(["/web/action/load"]);
    // The hotkey service turns `accesskey="c"` into `data-hotkey` on the first Alt press.
    // On small screens the control panel buttons live in its adaptive "More" bottom sheet.
    const toggle = `${isSmall() ? ".o-control-panel-adaptive-dropdown.dropdown-menu " : ""}.o-dropdown-caret:contains(Generate)`;
    const menu = ".o_lead_mining_menu_choices";
    const revealToggle = async () => {
        if (isSmall() && !queryAll(toggle).length) {
            await contains(".o_control_panel_main_buttons button[title=More]").click();
            await animationFrame();
        }
    };
    await revealToggle();
    expect(toggle).toHaveCount(1);
    expect(toggle).toBeEnabled();

    await setOffline(true);
    // The toggle is disabled: click, keyboard and its Alt+C hotkey open nothing.
    expect(toggle).not.toBeEnabled();
    await activateByPointerAndKeyboard(toggle);
    await press(["alt", "c"]);
    await settle();
    expect(menu).toHaveCount(0);
    // Direct calls of the four handlers: no module lookup, no access probe, no action.
    await dropdown.toggleDropdown();
    for (const element of dropdown.state.dropdownContentElements) {
        await dropdown.onClickAction(element);
    }
    await dropdown.redirectToImport();
    await dropdown.requestAccess("mass_mailing", "Email Marketing", true);
    await settle();
    expect(menu).toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    expect.verifySteps([]);

    // Online, the dropdown opens with its module lookup and offers installation.
    await setOffline(false);
    await animationFrame();
    await revealToggle();
    expect(toggle).toBeEnabled();
    await contains(toggle).click();
    await expect.waitForSteps(["/web/dataset/call_kw/ir.module.module/search_read"]);
    expect(`${menu} .o_lead_mining_element`).toHaveCount(6);
    await contains(`${menu} .o_lead_mining_element[data-module-xml-id='base.module_website']`).click();
    expect(".modal .modal-body").toHaveText('Do you want to install the "Website" App?');
    await contains(".modal-footer .btn-secondary").click();
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

test("[Offline] lead generation install confirmation opened online installs nothing offline", async () => {
    let dropdown = null;
    patchWithCleanup(LeadGenerationDropdown.prototype, {
        setup() {
            super.setup(...arguments);
            dropdown = this;
        },
    });
    let dialog = null;
    patchWithCleanup(CrmInstallConfirmationDialog.prototype, {
        setup() {
            super.setup(...arguments);
            dialog = this;
        },
    });
    // The server refuses the installation, so a confirmed install never reloads the page.
    const serverMessage = "Website dependencies could not be resolved";
    onRpc("ir.module.module", "button_immediate_install", ({ args }) => {
        expect.step(`button_immediate_install ${JSON.stringify(args)}`);
        throw makeServerError({ message: serverMessage });
    });
    /** Arguments of every `console.error` call. */
    const logged = [];
    patchWithCleanup(console, {
        error(...args) {
            expect.step("console.error");
            logged.push(args);
        },
    });
    const setOffline = mockOffline();
    const INSTALL = "/web/dataset/call_kw/ir.module.module/button_immediate_install";
    /** The route whose next request loses the connection (502 answer), if any. */
    const lost = { route: null };
    onRpc("/*", (request) => {
        if (lost.route && new URL(request.url).pathname === lost.route) {
            lost.route = null;
            return new Response("", { status: 502 });
        }
    });
    stepRoutes((route) => route.includes("/ir.module.module/"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(PIPELINE_ACTION.id);
    await flushStartupSync();
    // On small screens the control panel buttons live in its adaptive "More" bottom sheet.
    const toggle = `${isSmall() ? ".o-control-panel-adaptive-dropdown.dropdown-menu " : ""}.o-dropdown-caret:contains(Generate)`;
    const websiteItem =
        ".o_lead_mining_menu_choices .o_lead_mining_element[data-module-xml-id='base.module_website']";
    /** Opens the dropdown when it is closed, then asks to install Website. */
    const openWebsiteConfirmation = async () => {
        if (!queryAll(websiteItem).length) {
            if (isSmall() && !queryAll(toggle).length) {
                await contains(".o_control_panel_main_buttons button[title=More]").click();
                await animationFrame();
            }
            await contains(toggle).click();
        }
        await contains(websiteItem).click();
    };
    await openWebsiteConfirmation();
    expect.verifySteps(["/web/dataset/call_kw/ir.module.module/search_read"]);
    const body = ".modal .modal-body";
    const confirm = ".modal-footer .btn-primary:contains(Install)";
    const cancel = ".modal-footer .btn-secondary";
    const website = () =>
        dropdown.state.dropdownContentElements.find(
            (element) => element.moduleXmlId === "base.module_website"
        );
    expect(body).toHaveText('Do you want to install the "Website" App?');
    expect(confirm).toBeEnabled();
    expect(confirm).not.toHaveAttribute("data-available-offline");
    expect(cancel).toHaveAttribute("data-available-offline");

    await setOffline(true);
    expect(confirm).not.toBeEnabled();
    expect(confirm).toHaveClass("o_disabled_offline");
    expect(cancel).toBeEnabled();
    // Click, Enter, Space and the Alt+Q hotkey install nothing.
    await activateByPointerAndKeyboard(confirm);
    await press(["alt", "q"]);
    await settle();
    // Direct calls of the dialog's confirmation and of the dropdown's callback neither.
    await dialog._confirm();
    await dialog.props.confirm();
    await settle();
    expect(body).toHaveText('Do you want to install the "Website" App?');
    expect(".modal").toHaveCount(1);
    expect(confirm).not.toBeEnabled();
    expect(cancel).toBeEnabled();
    expect(".o_error_dialog").toHaveCount(0);
    expect(website().status).toBe("NOT_INSTALLED");
    expect(website().title).toBe("Website");
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);
    expect.verifySteps([]);

    // Online, Confirm is enabled again and installs. The server's refusal is shown in the
    // error dialog and logged, as for any failed installation.
    await setOffline(false);
    await animationFrame();
    expect(confirm).toBeEnabled();
    expect(confirm).not.toHaveClass("o_disabled_offline");
    await contains(confirm).click();
    await expect.waitForSteps([INSTALL, "button_immediate_install [2]", "console.error"]);
    await animationFrame();
    expect(confirm).toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(1);
    expect(logged).toHaveLength(1);
    const [[refusal]] = logged;
    expect(refusal).toBeInstanceOf(RPCError);
    expect(refusal.message).toBe(serverMessage);
    expect(refusal.exceptionName).toBe("odoo.exceptions.UserError");
    const errorDetail = ".o_error_dialog .o_error_detail code.d-block";
    expect(queryFirst(errorDetail).textContent).toBe(String(refusal));
    expect(queryFirst(".o_error_dialog").textContent).not.toInclude('Failed to install "Website"');
    expect(website().status).toBe("FAILED_TO_INSTALL");
    expect(website().title).toBe('Failed to install "Website"');
    expect(getService(OfflinePlugin).isOffline()).toBe(false);
    expect.verifySteps([]);

    // Online, an installation whose request loses the connection never reaches the server:
    // the failure shows only a fixed text and logs nothing.
    await contains(".o_error_dialog .modal-footer .btn-primary").click();
    expect(".o_error_dialog").toHaveCount(0);
    await openWebsiteConfirmation();
    expect(body).toHaveText('Do you want to install the "Website" App?');
    expect(confirm).toBeEnabled();
    lost.route = INSTALL;
    await contains(confirm).click();
    await expect.waitForSteps([INSTALL]);
    await animationFrame();
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    // The network is kept down, so that no timer reconnects while the test settles.
    await setOffline(true);
    await settle();
    expect(confirm).toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(1);
    expect(errorDetail).toHaveCount(1);
    expect(queryFirst(errorDetail).textContent).toBe('Failed to install "Website"');
    const lostText = queryFirst(".o_error_dialog").textContent;
    expect(lostText).not.toInclude(INSTALL);
    expect(lostText).not.toInclude("Connection");
    expect(lostText).not.toInclude(serverMessage);
    expect(website().status).toBe("FAILED_TO_INSTALL");
    expect(website().title).toBe('Failed to install "Website"');
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);
    expect(logged).toHaveLength(1);
    expect.verifySteps([]);
});

test("[Offline] predictive scoring tooltip and AI switch disabled", async () => {
    const setOffline = mockOffline();
    stepRoutes(
        (route) =>
            route.startsWith("/web/dataset/call_button/") ||
            route === "/web/dataset/call_kw/crm.lead/web_save" ||
            route === "/web/dataset/call_kw/crm.lead/prepare_pls_tooltip_data"
    );
    const { env } = await makeMockServer();
    // Lead 2 uses AI-computed probabilities (tooltip); lead 1 does not (AI switch).
    env["crm.lead"].write([2], { is_automated_probability: true });
    const tooltipButtons = [];
    patchWithCleanup(CrmPlsTooltipButton.prototype, {
        setup() {
            super.setup(...arguments);
            tooltipButtons.push(this);
        },
    });
    let controller = null;
    patchWithCleanup(CrmFormController.prototype, {
        setup() {
            super.setup(...arguments);
            controller = this;
        },
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    const tooltipButton = ".o_crm_pls_tooltip_button";
    const aiSwitch = "a[name=action_set_automated_probability]";
    const tooltip = ".o_crm_pls_tooltip";

    // Tooltip button (wide and small layouts), edited lead.
    await openLead(2);
    expect(tooltipButton).toHaveCount(2);
    expect(`${tooltipButton}:visible`).toHaveCount(1);
    expect(tooltipButton).toBeEnabled();
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 2 edited");
    for (const button of queryAll(tooltipButton)) {
        expect(button).not.toBeEnabled();
    }
    await activateByPointerAndKeyboard(`${tooltipButton}:visible`);
    // Direct calls of every rendered button's handler: no save, no lookup.
    for (const button of tooltipButtons.filter((button) => button.props.record.resId === 2)) {
        await button.onClickPlsTooltipButton();
    }
    await settle();
    expect(tooltip).toHaveCount(0);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 2 edited");
    expect(queued("crm.lead")).toEqual([]);
    expect.verifySteps([]);

    // Online, the button saves the pending edit, looks the data up and opens the tooltip.
    await setOffline(false);
    await animationFrame();
    expect(`${tooltipButton}:visible`).toBeEnabled();
    await contains(`${tooltipButton}:visible`).click();
    await expect.waitForSteps([
        "/web/dataset/call_kw/crm.lead/web_save",
        "/web/dataset/call_kw/crm.lead/prepare_pls_tooltip_data",
        "prepare_pls_tooltip_data 2",
    ]);
    await animationFrame();
    expect(tooltip).toHaveCount(1);
    expect(`${tooltip} .o_crm_pls_tooltip_wheel`).toHaveText("42%");
    expect(tooltip).toHaveText(/Europe/);
    expect(MockServer.env["crm.lead"].browse(2)[0].name).toBe("Lead 2 edited");
    await press("Escape");
    await animationFrame();

    // AI switch (wide and small layouts) of a manually scored lead.
    await goBack();
    await openLead(1);
    expectUnguarded(aiSwitch, 2);
    await setOffline(true);
    expectGuarded(aiSwitch, 2);
    await activateByPointerAndKeyboard(`${aiSwitch}:visible`);
    expect(
        await controller.beforeExecuteActionButton({
            type: "object",
            name: "action_set_automated_probability",
        })
    ).toBe(false);
    await callButton({ resModel: "crm.lead", name: "action_set_automated_probability", resId: 1 });
    await settle();
    expect(".modal").toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
    expect.verifySteps([]);
    await setOffline(false);
    await animationFrame();
    expectUnguarded(aiSwitch, 2);
    await contains(`${aiSwitch}:visible`).click();
    await expect.waitForSteps([
        buttonRoute("crm.lead", "action_set_automated_probability"),
        "action_set_automated_probability [1]",
    ]);
});

/** Opportunities with their activity controls (list, then pipeline kanban). */
const LEAD_ACTIVITIES_ACTION = {
    type: "ir.actions.act_window",
    name: "Opportunities",
    res_model: "crm.lead",
    views: [
        [ACTIVITY_LIST_VIEW_ID, "list"],
        [ACTIVITY_KANBAN_VIEW_ID, "kanban"],
    ],
};

test("[Offline] CRM activity menu entry disabled", async () => {
    const { env } = await makeMockServer();
    // The reschedule dropdown shows for a lead with an activity of the user.
    env["crm.lead"].write([1], { my_activity_date_deadline: "2010-01-01" });
    env["mail.activity"].create([
        // Late and future against the test clock.
        { res_model: "crm.lead", res_id: 1, user_id: serverState.userId, date_deadline: "2010-01-01" },
        { res_model: "crm.lead", res_id: 2, user_id: serverState.userId, date_deadline: "2999-01-01" },
        {
            res_model: "res.partner",
            res_id: serverState.partnerId,
            user_id: serverState.userId,
            date_deadline: "2999-01-01",
        },
    ]);
    let activityMenu = null;
    patchWithCleanup(registry.category("systray").get("mail.activity_menu").Component.prototype, {
        setup() {
            super.setup(...arguments);
            activityMenu = this;
        },
    });
    const setOffline = mockOffline();
    stepRoutes(
        (route) => route === "/web/action/load" || route.startsWith("/web/dataset/call_button/")
    );
    await mountWithCleanup(WebClient);
    await getService("action").doAction(PIPELINE_ACTION.id);
    await flushStartupSync();
    expect.verifySteps(["/web/action/load"]);
    const crmRow = ".o-mail-ActivityGroup[data-model_name='crm.lead']";
    // The "Late", "Today" and "Future" counters (the fourth span is a spacer).
    const crmCounters = `${crmRow} span.py-0`;
    const partnerRow = ".o-mail-ActivityGroup[data-model_name='res.partner']";

    // The menu is opened online.
    await contains(".o_menu_systray i[aria-label='Activities']").click();
    await waitFor(crmRow);
    expect(crmCounters).toHaveCount(3);
    expect(queryAllTexts(crmCounters)).toEqual(["1 Late", "0 Today", "1 Future"]);
    for (const el of queryAll(`${crmRow}, ${crmCounters}`)) {
        expect(el).not.toHaveClass("o_disabled_offline");
        expect(el).not.toHaveAttribute("aria-disabled");
    }

    // Offline, the CRM row and its counters are disabled, out of the tab order and
    // inert; the other rows keep their state.
    await setOffline(true);
    await animationFrame();
    const tabbable = getFocusableElements({ tabbable: true });
    for (const el of queryAll(`${crmRow}, ${crmCounters}`)) {
        expect(el).toHaveClass(["o_disabled_offline", "pe-none"]);
        expect(el).toHaveAttribute("aria-disabled", "true");
        expect(el).toHaveAttribute("tabindex", "-1");
        expect(tabbable).not.toInclude(el);
    }
    expect(partnerRow).not.toHaveClass("o_disabled_offline");
    for (const el of queryAll(`${crmCounters}, ${crmRow}`)) {
        await click(el);
        el.focus();
        if (document.activeElement === el) {
            await press("Enter");
            await press(" ");
        }
        await animationFrame();
    }
    // Direct calls with every counter filter.
    const crmGroup = activityMenu.store.activityGroups.find((group) => group.model === "crm.lead");
    for (const filter of ["all", "my", "overdue", "today", "upcoming_all"]) {
        await activityMenu.openActivityGroup(crmGroup, filter);
    }
    await settle();
    // The menu stays open on the current view, and My Activities is not loaded.
    expect(crmRow).toHaveCount(1);
    expect(currentView()).toBe("crm.crm_lead_action_pipeline/kanban");
    expect.verifySteps([]);
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);

    // Online, the CRM row opens My Activities.
    await setOffline(false);
    await animationFrame();
    for (const el of queryAll(`${crmRow}, ${crmCounters}`)) {
        expect(el).not.toHaveClass("o_disabled_offline");
        expect(el).not.toHaveAttribute("aria-disabled");
    }
    await contains(crmRow).click();
    await expect.waitForSteps(["/web/action/load"]);
    // Small screens open the action's kanban view instead of its list.
    const myActivitiesView = `crm.crm_lead_action_my_activities/${isSmall() ? "kanban" : "list"}`;
    await expectCurrentView(myActivitiesView);
    expect(crmRow).toHaveCount(0);
    // The row filters the late and today's activities...
    const rowContext = getService("action").currentController.action.context;
    expect(rowContext.search_default_activities_overdue).toBe(1);
    expect(rowContext.search_default_activities_today).toBe(1);
    expect(rowContext.search_default_activities_upcoming_all).toBe(undefined);
    // ... and each counter (Late, Today, Future), from the menu opened again, opens
    // My Activities with its own filter (the action loaded above is reused from the
    // RPC cache).
    const counterFilters = [
        "search_default_activities_overdue",
        "search_default_activities_today",
        "search_default_activities_upcoming_all",
    ];
    for (const [index, filter] of counterFilters.entries()) {
        await getService("action").doAction(PIPELINE_ACTION.id, { clearBreadcrumbs: true });
        await expectCurrentView("crm.crm_lead_action_pipeline/kanban");
        await contains(".o_menu_systray i[aria-label='Activities']").click();
        await waitFor(crmRow);
        await contains(queryAll(crmCounters)[index]).click();
        await expectCurrentView(myActivitiesView);
        expect(crmRow).toHaveCount(0);
        const { context } = getService("action").currentController.action;
        for (const otherFilter of counterFilters) {
            expect(context[otherFilter]).toBe(otherFilter === filter ? 1 : undefined, {
                message: `${filter}: ${otherFilter}`,
            });
        }
    }
    expect.verifySteps([]);

    // The other activity controls of the lead views, opened online: the list
    // activity button and reschedule dropdown, and the pipeline card activity button
    // (wide layout; the small-screen pipeline has its own activity sheet).
    await getService("action").doAction(LEAD_ACTIVITIES_ACTION, { clearBreadcrumbs: true });
    await animationFrame();
    const listActivityButtons = ".o_data_row .o-mail-ActivityButton";
    const rescheduleToggles = ".o_data_row button:has(.o_dropdown_title:contains(Reschedule))";
    const popover = ".o-mail-ActivityListPopover";
    expect(listActivityButtons).not.toHaveCount(0);
    expect(rescheduleToggles).not.toHaveCount(0);
    // A lead's reschedule menu and its date picker, opened online, close as soon
    // as the connection drops, with no request.
    const rescheduleItems = ".o-dropdown--menu .o-dropdown-item";
    const datePicker = ".o_datetime_picker";
    await contains(`.o_data_row:eq(0) ${rescheduleToggles.replace(".o_data_row ", "")}`).click();
    await waitFor(`${rescheduleItems}:contains(Today)`, { visible: true });
    expect(`${rescheduleItems}:contains(Today)`).toBeVisible();
    await contains(`${rescheduleItems} input.o_datetime_input`).click();
    await waitFor(datePicker, { visible: true });
    expect(datePicker).toBeVisible();
    await setOffline(true);
    await animationFrame();
    expect(rescheduleItems).toHaveCount(0);
    expect(datePicker).toHaveCount(0);
    expect.verifySteps([]);
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);
    for (const button of queryAll(`${listActivityButtons}, ${rescheduleToggles}`)) {
        expect(button).not.toBeEnabled();
    }
    await click(queryFirst(listActivityButtons));
    await click(queryFirst(rescheduleToggles));
    await animationFrame();
    expect(popover).toHaveCount(0);
    expect(".o-dropdown--menu .o-dropdown-item:contains(Today)").toHaveCount(0);
    // A direct reschedule call issues nothing.
    await callButton({ resModel: "crm.lead", name: "action_reschedule_my_next_today", resId: 1 });
    await settle();
    expect.verifySteps([]);
    await setOffline(false);
    await animationFrame();
    await contains(`.o_data_row:eq(0) .o-mail-ActivityButton`).click();
    await waitFor(popover);
    await press("Escape");
    await animationFrame();
    await contains(`.o_data_row:eq(0) ${rescheduleToggles.replace(".o_data_row ", "")}`).click();
    await contains(".o-dropdown--menu .o-dropdown-item:contains(Today)").click();
    await expect.waitForSteps([
        buttonRoute("crm.lead", "action_reschedule_my_next_today"),
        "action_reschedule_my_next_today [1]",
    ]);
    if (!isSmall()) {
        await getService("action").switchView("kanban");
        await animationFrame();
        const cardActivityButtons = ".o_kanban_record .o-mail-ActivityButton";
        expect(cardActivityButtons).not.toHaveCount(0);
        await setOffline(true);
        for (const button of queryAll(cardActivityButtons)) {
            expect(button).not.toBeEnabled();
        }
        await click(queryFirst(cardActivityButtons));
        await animationFrame();
        expect(popover).toHaveCount(0);
        await setOffline(false);
        await animationFrame();
        await contains(`.o_kanban_record:contains(Lead 1) .o-mail-ActivityButton`).click();
        await waitFor(popover);
    }
});

/** View id of a `res.partner` list with the partners' `list_activity` button. */
const PARTNER_ACTIVITY_LIST_VIEW_ID = 501;

test("[Offline] lead activity buttons open no popover and fetch nothing offline", async () => {
    // A control outside CRM: the activity button of a partner list.
    registerInlineViewArchs("res.partner", {
        [`list,${PARTNER_ACTIVITY_LIST_VIEW_ID}`]: /* xml */ `
            <list>
                <field name="name"/>
                <field name="activity_ids" widget="list_activity"/>
            </list>`,
    });
    const { env } = await makeMockServer();
    env["mail.activity"].create([
        {
            res_model: "crm.lead",
            res_id: 1,
            user_id: serverState.userId,
            date_deadline: "2010-01-01",
        },
        {
            res_model: "res.partner",
            res_id: serverState.partnerId,
            user_id: serverState.userId,
            date_deadline: "2999-01-01",
        },
    ]);
    // The real button instances (list rows and kanban cards), in mount order.
    const buttons = [];
    patchWithCleanup(ActivityButton.prototype, {
        setup() {
            super.setup(...arguments);
            buttons.push(this);
        },
    });
    const setOffline = mockOffline();
    const mailRequests = trackMailRequests();
    stepRoutes(
        (route) => route === "/web/action/load" || route.startsWith("/web/dataset/call_button/")
    );
    const popover = ".o-mail-ActivityListPopover";

    /**
     * The mounted activity button of a record in the displayed view.
     *
     * @param {string} resModel
     * @param {number} resId
     * @param {string} container selector of the row or card holding the button
     */
    function activityButton(resModel, resId, container) {
        const button = buttons.findLast(
            ({ props }) => props.record.resModel === resModel && props.record.resId === resId
        );
        expect(button.buttonRef().isConnected).toBe(true);
        expect(button.buttonRef().closest(container)).not.toBe(null);
        return button;
    }

    /**
     * Proves the DISABLE member on the button of lead 1: it works online, a popover
     * opened online closes when the connection drops, offline neither a click nor a
     * direct call opens it or issues a request, and online the direct call opens it.
     *
     * @param {string} container
     */
    async function expectLeadActivityButtonGuarded(container) {
        let button = activityButton("crm.lead", 1, container);
        const { record } = button.props;
        const activityData = () => ({
            activityIds: [...record.data.activity_ids.currentIds],
            activityState: record.data.activity_state,
        });
        const onlineData = activityData();
        expect(onlineData.activityIds).not.toEqual([]);

        // Online, a click opens the popover, whose setup fetches the activities.
        await settle();
        mailRequests.length = 0;
        await click(button.buttonRef());
        await waitFor(popover);
        await runAllTimers();
        expect(mailRequests).toEqual(["/mail/store"]);

        // The connection drops: the popover opened online closes.
        await setOffline(true);
        await animationFrame();
        expect(popover).toHaveCount(0);
        expect(button.popover.isOpen).toBe(false);

        // Offline, the disabled button (out of the tab order, unfocusable, so no
        // Enter or Space reaches it) and a direct call open nothing and fetch, load,
        // queue and change nothing.
        mailRequests.length = 0;
        expect(button.buttonRef()).not.toBeEnabled();
        expect(getFocusableElements({ tabbable: true })).not.toInclude(button.buttonRef());
        button.buttonRef().focus();
        expect(document.activeElement).not.toBe(button.buttonRef());
        await click(button.buttonRef());
        await button.onClick();
        await settle();
        expect(popover).toHaveCount(0);
        expect(button.popover.isOpen).toBe(false);
        expect(mailRequests).toEqual([]);
        expect.verifySteps([]);
        expect(queued("crm.lead")).toEqual([]);
        expect(queued("mail.activity")).toEqual([]);
        expect(activityData()).toEqual(onlineData);

        // Online again, the same direct call opens the popover, and closes it.
        await setOffline(false);
        await settle();
        button = activityButton("crm.lead", 1, container);
        expect(button.buttonRef()).toBeEnabled();
        mailRequests.length = 0;
        await button.onClick();
        await waitFor(popover);
        await runAllTimers();
        expect(mailRequests).toEqual(["/mail/store"]);
        await button.onClick();
        await animationFrame();
        expect(popover).toHaveCount(0);
        expect.verifySteps([]);
    }

    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEAD_ACTIVITIES_ACTION);
    await flushStartupSync();
    expect.verifySteps([]);
    // The Opportunities list (`list_activity`).
    await expectLeadActivityButtonGuarded(".o_data_row");
    // The pipeline card (`kanban_activity`; the small-screen pipeline has its own
    // activity sheet).
    if (!isSmall()) {
        await getService("action").switchView("kanban");
        await animationFrame();
        await expectLeadActivityButtonGuarded(".o_kanban_record");
    }

    // Outside CRM nothing changes: a partner's popover opened online stays open when
    // the connection drops, and the direct call still toggles it closed, with no
    // request.
    await getService("action").doAction({
        type: "ir.actions.act_window",
        res_model: "res.partner",
        views: [[PARTNER_ACTIVITY_LIST_VIEW_ID, "list"]],
    });
    await animationFrame();
    const partnerButton = activityButton("res.partner", serverState.partnerId, ".o_data_row");
    await click(partnerButton.buttonRef());
    await waitFor(popover);
    await runAllTimers();
    await setOffline(true);
    await animationFrame();
    expect(popover).toHaveCount(1);
    expect(partnerButton.popover.isOpen).toBe(true);
    mailRequests.length = 0;
    await partnerButton.onClick();
    await settle();
    expect(popover).toHaveCount(0);
    expect(mailRequests).toEqual([]);
    expect.verifySteps([]);
});

test("[Offline] share target lead item neither reads teams nor creates", async () => {
    // Framework error of an offline start, not CRM: mail's start-up store fetch.
    expect.errors(1);
    const sharedFile = new File([new Uint8Array(1)], "card.png", { type: "image/png" });
    patchWithCleanup(shareTargetService, { _getShareTargetFiles: async () => [sharedFile] });
    const { env } = await makeMockServer();
    const attachmentId = env["ir.attachment"].create({ name: "card.png" });
    onRpc("/web/binary/upload_attachment", () => {
        expect.step("upload_attachment");
        return [{ id: attachmentId, filename: "card.png" }];
    });
    patchWithCleanup(user, {
        async activateCompanies(companyIds) {
            expect.step(`activateCompanies ${JSON.stringify(companyIds)}`);
        },
    });
    let leadItem = null;
    patchWithCleanup(CrmShareTargetItem.prototype, {
        setup() {
            super.setup(...arguments);
            leadItem = this;
        },
    });
    const setOffline = mockOffline();
    stepRoutes(
        (route) =>
            route.includes("/crm.team/") ||
            route.includes("/crm.lead/name_create") ||
            route.includes("/ir.attachment/")
    );
    // A file is shared while the device is offline: the app starts, then the share
    // target dialog opens on the lead item (the only share target of the module set).
    await makeTestApp();
    await setOffline(true);
    await mountWithCleanup(WebClient);
    await animationFrame();
    expect.verifyErrors(['Connection to "/mail/store"']);
    const teamSection = ".o_dialog h3:contains(In sales team)";
    const createButton = ".o_dialog footer .btn-primary";
    expect(".o_dialog .modal-body button.active").toHaveText("Lead");
    expect(leadItem.state.teams).toEqual([]);
    expect(teamSection).toHaveCount(0);
    // The dialog's Create button is disabled by the framework.
    expect(createButton).not.toBeEnabled();
    await activateByPointerAndKeyboard(createButton);
    // Direct calls: the team reads (also after a company change), the save hook's
    // company switch, the processing and the record creation do nothing.
    await leadItem.updateTeams();
    leadItem.onCompanyChange({ id: 2, display_name: "Branch" });
    await leadItem.checkAndActiveIfNeededUserCompany();
    await leadItem.process();
    expect(await leadItem._createRecord("card.png", leadItem.context)).toBe(null);
    await settle();
    expect(".o_dialog").toHaveCount(1);
    expect(".o_dialog .o_form_view").toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
    expect.verifySteps([]);

    // The connection comes back: the teams are read.
    await setOffline(false);
    await expect.waitForSteps(["/web/dataset/call_kw/crm.team/web_search_read"]);
    await animationFrame();
    expect(leadItem.state.teams.map((team) => team.display_name)).toEqual(["Europe", "America"]);
    expect(teamSection).toHaveCount(1);
    expect(".o_dialog .o_field_widget[name=team] input").toHaveValue("Europe");

    // A second disconnection keeps the team list and the selection.
    await setOffline(true);
    await leadItem.updateTeams();
    await settle();
    expect(leadItem.state.selected_team.display_name).toBe("Europe");
    expect(teamSection).toHaveCount(1);
    expect.verifySteps([]);

    // Online, Create switches the company, uploads, creates the lead and opens it.
    await setOffline(false);
    await expect.waitForSteps(["/web/dataset/call_kw/crm.team/web_search_read"]);
    await contains(".o_dialog footer .btn-primary").click();
    await expect.waitForSteps([
        "activateCompanies [1,2]",
        "upload_attachment",
        "/web/dataset/call_kw/crm.lead/name_create",
        "/web/dataset/call_kw/ir.attachment/write",
    ]);
    await animationFrame();
    expect(".o_dialog").toHaveCount(0);
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("card.png");
    const [lead] = MockServer.env["crm.lead"].search_read([["name", "=", "card.png"]]);
    expect(lead.team_id[0]).toBe(1);
    expect(MockServer.env["ir.attachment"].browse(attachmentId)[0].res_id).toBe(lead.id);
});

test("[Offline] share target team read on reconnection: retried when lost, reported once when refused", async () => {
    // The server error injected into one reconnection read, shown by the framework.
    expect.errors(1);
    const TEAM_READ = "/web/dataset/call_kw/crm.team/web_search_read";
    const sharedFile = new File([new Uint8Array(1)], "card.png", { type: "image/png" });
    patchWithCleanup(shareTargetService, { _getShareTargetFiles: async () => [sharedFile] });
    let leadItem = null;
    patchWithCleanup(CrmShareTargetItem.prototype, {
        setup() {
            super.setup(...arguments);
            leadItem = this;
        },
    });
    /** The next team read: `"lost"` (502 answer) or `"refused"` (server error). */
    const teamReads = { next: false };
    onRpc("crm.team", "web_search_read", () => {
        expect.step("crm.team read");
        if (teamReads.next === "refused") {
            teamReads.next = false;
            throw makeServerError({ message: "Team read refused" });
        }
    });
    const setOffline = mockOffline();
    onRpc("/*", (request) => {
        if (teamReads.next === "lost" && new URL(request.url).pathname === TEAM_READ) {
            teamReads.next = false;
            expect.step("crm.team read lost");
            return new Response("", { status: 502 });
        }
    });
    // A file is shared online: the dialog opens on the lead item, which reads the teams.
    await makeTestApp();
    await mountWithCleanup(WebClient);
    await expect.waitForSteps(["crm.team read"]);
    await animationFrame();
    const teamNames = () => leadItem.state.teams.map((team) => team.display_name);
    const teamInput = ".o_dialog .o_field_widget[name=team] input";
    expect(teamNames()).toEqual(["Europe", "America"]);
    leadItem.state.selected_team = leadItem.state.teams[1];
    await animationFrame();
    expect(teamInput).toHaveValue("America");

    // The connection drops again during the read that follows a reconnection: the
    // teams and the selection are kept, and nothing is raised.
    await setOffline(true);
    teamReads.next = "lost";
    await setOffline(false);
    await expect.waitForSteps(["crm.team read lost"]);
    await animationFrame();
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    expect(teamNames()).toEqual(["Europe", "America"]);
    expect(teamInput).toHaveValue("America");
    expect(".o_error_dialog").toHaveCount(0);
    expect.verifyErrors([]);

    // The next reconnection reads them again; a server error reaches the framework
    // error handling once, and keeps them too.
    teamReads.next = "refused";
    await setOffline(false);
    await expect.waitForSteps(["crm.team read"]);
    await waitFor(".o_error_dialog:contains(Team read refused)");
    expect(teamNames()).toEqual(["Europe", "America"]);
    expect(teamInput).toHaveValue("America");
    expect.verifyErrors(["Team read refused"]);
    await contains(".o_error_dialog .modal-footer .btn-primary").click();

    // A read that succeeds restores the online team selection.
    await setOffline(true);
    await setOffline(false);
    await expect.waitForSteps(["crm.team read"]);
    await animationFrame();
    expect(teamInput).toHaveValue("Europe");
    expect.verifyErrors([]);
});

test("[Offline] share target save started online stops when the connection drops during the upload", async () => {
    const sharedFile = new File([new Uint8Array(1)], "card.png", { type: "image/png" });
    patchWithCleanup(shareTargetService, { _getShareTargetFiles: async () => [sharedFile] });
    const { env } = await makeMockServer();
    const attachmentId = env["ir.attachment"].create({ name: "card.png" });
    /** Holds each upload until the test releases it, once the connection has dropped. */
    let heldUpload = null;
    onRpc("/web/binary/upload_attachment", async () => {
        expect.step("upload_attachment");
        await heldUpload.promise;
        return [{ id: attachmentId, filename: "card.png" }];
    });
    let leadItem = null;
    patchWithCleanup(CrmShareTargetItem.prototype, {
        setup() {
            super.setup(...arguments);
            leadItem = this;
        },
    });
    const setOffline = mockOffline();
    stepRoutes(
        (route) =>
            route.includes("/crm.team/") ||
            route.includes("/crm.lead/") ||
            route.includes("/ir.attachment/")
    );
    const attachmentLink = () => {
        const [{ res_id, res_model }] = MockServer.env["ir.attachment"].browse(attachmentId);
        return { res_id, res_model };
    };
    const unlinked = attachmentLink();
    const sharedLeads = () => MockServer.env["crm.lead"].search([["name", "=", "card.png"]]);
    const expectNothingSaved = () => {
        expect.verifySteps([]);
        expect(".o_form_view").toHaveCount(0);
        expect(attachmentLink()).toEqual(unlinked);
        expect(sharedLeads()).toEqual([]);
        expect(queued("crm.lead")).toEqual([]);
        expect(queued("ir.attachment")).toEqual([]);
    };
    // A file is shared online: the dialog opens on the lead item, which reads the teams.
    await makeTestApp();
    await mountWithCleanup(WebClient);
    await expect.waitForSteps(["/web/dataset/call_kw/crm.team/web_search_read"]);
    await animationFrame();
    const offlinePlugin = getService(OfflinePlugin);

    // A save started online, whose upload ends once the offline signal is set while the
    // mock server still answers: a stale signal, which only an RPC response clears (the
    // upload is a plain fetch and clears nothing). `mockOffline()` would also answer 502
    // to any later request, so only the signal is set here.
    heldUpload = Promise.withResolvers();
    const processing = leadItem.process();
    await expect.waitForSteps(["upload_attachment"]);
    offlinePlugin.setOffline(true);
    await animationFrame();
    heldUpload.resolve();
    await processing;
    await animationFrame();
    expect(offlinePlugin.isOffline()).toBe(true);
    expect(".o_dialog").toHaveCount(1);
    expectNothingSaved();

    // Direct calls offline: no lead is created, no attachment relinked, no record opened.
    const uploaded = [{ id: attachmentId, filename: "card.png" }];
    expect(await leadItem.createRecordWithFile(uploaded)).toBe(null);
    await leadItem.openCreatedRecord(1);
    await animationFrame();
    expectNothingSaved();

    // The connection comes back: the teams are read again, the stopped save is not resumed.
    await setOffline(false);
    await expect.waitForSteps(["/web/dataset/call_kw/crm.team/web_search_read"]);
    await settle();
    expectNothingSaved();

    // A save started online by the dialog's Create button, whose upload ends after the
    // connection is lost (signal and network): nothing is saved, and the save ends, so the
    // dialog closes as after any save.
    heldUpload = Promise.withResolvers();
    await contains(".o_dialog footer .btn-primary").click();
    await expect.waitForSteps(["upload_attachment"]);
    await setOffline(true);
    heldUpload.resolve();
    await settle();
    expect(".o_dialog").toHaveCount(0);
    expectNothingSaved();

    // Back online, nothing of the stopped save is replayed.
    await setOffline(false);
    await settle();
    expectNothingSaved();
});

test("[Offline] share target lead creation started online: no form fallback once the connection is lost", async () => {
    const TEAM_READ = "/web/dataset/call_kw/crm.team/web_search_read";
    const NAME_CREATE = "/web/dataset/call_kw/crm.lead/name_create";
    const WEB_SAVE = "/web/dataset/call_kw/crm.lead/web_save";
    const ATTACHMENT_WRITE = "/web/dataset/call_kw/ir.attachment/write";
    const sharedFile = new File([new Uint8Array(1)], "card.png", { type: "image/png" });
    patchWithCleanup(shareTargetService, { _getShareTargetFiles: async () => [sharedFile] });
    const { env } = await makeMockServer();
    const attachmentId = env["ir.attachment"].create({ name: "card.png" });
    onRpc("/web/binary/upload_attachment", () => {
        expect.step("upload_attachment");
        return [{ id: attachmentId, filename: "card.png" }];
    });
    /** When `refused`, the next name_create fails with a server error. */
    const nameCreate = { refused: false };
    onRpc("crm.lead", "name_create", () => {
        if (nameCreate.refused) {
            nameCreate.refused = false;
            throw makeServerError({ message: "Lead name refused" });
        }
    });
    let leadItem = null;
    patchWithCleanup(CrmShareTargetItem.prototype, {
        setup() {
            super.setup(...arguments);
            leadItem = this;
        },
    });
    const setOffline = mockOffline();
    /** The route whose next request loses the connection (502 answer), if any. */
    const lost = { route: null };
    onRpc("/*", (request) => {
        if (lost.route && new URL(request.url).pathname === lost.route) {
            lost.route = null;
            return new Response("", { status: 502 });
        }
    });
    stepRoutes(
        (route) =>
            [TEAM_READ, NAME_CREATE, WEB_SAVE].includes(route) || route.includes("/ir.attachment/")
    );
    const attachmentLink = () => {
        const [{ res_id, res_model }] = MockServer.env["ir.attachment"].browse(attachmentId);
        return { res_id, res_model };
    };
    const sharedLeads = () => MockServer.env["crm.lead"].search([["name", "=", "card.png"]]);
    const createButton = ".o_dialog footer .btn-primary";
    const formDialog = ".o_dialog:has(.o_form_view)";
    const dialogsClosed = () => waitUntil(() => !queryFirst(".o_dialog"));
    /** Shares the file again: the dialog opens on a new lead item, which reads the teams. */
    const shareAgain = async () => {
        getService("share_target").display([sharedFile]);
        await expect.waitForSteps([TEAM_READ]);
        await animationFrame();
    };
    /** Starts a save online whose name_create is refused: the base form fallback opens. */
    const openFormFallback = async () => {
        nameCreate.refused = true;
        await contains(createButton).click();
        await expect.waitForSteps(["upload_attachment", NAME_CREATE]);
        await waitFor(`${formDialog} .o_field_widget[name=name] input`);
        expect(`${formDialog} .modal-title`).toHaveText("card.png");
        expect(`${formDialog} .o_field_widget[name=name] input`).toHaveValue("card.png");
    };
    // A file is shared online: the dialog opens on the lead item, which reads the teams.
    await makeTestApp();
    await mountWithCleanup(WebClient);
    await expect.waitForSteps([TEAM_READ]);
    await animationFrame();
    const offlinePlugin = getService(OfflinePlugin);
    const unlinked = attachmentLink();
    /** No lead, relink, queued call, form dialog or opened record. */
    const expectNothingSaved = () => {
        expect.verifySteps([]);
        expect(".o_form_view").toHaveCount(0);
        expect(attachmentLink()).toEqual(unlinked);
        expect(sharedLeads()).toEqual([]);
        expect(queued("crm.lead")).toEqual([]);
        expect(queued("ir.attachment")).toEqual([]);
    };

    // A direct lead creation online whose name_create loses the connection returns null
    // without the form fallback. The network is then kept down, so that no timer
    // reconnects while the test settles.
    lost.route = NAME_CREATE;
    expect(await leadItem._createRecord("card.png", leadItem.context)).toBe(null);
    expect(offlinePlugin.isOffline()).toBe(true);
    expect.verifySteps([NAME_CREATE]);
    await setOffline(true);
    await settle();
    expect(".o_dialog").toHaveCount(1);
    expectNothingSaved();

    // Back online, the dialog's Create: the upload ends, then name_create loses the
    // connection. No form fallback, relink or navigation; the save ends, so the dialog
    // closes as after any save.
    await setOffline(false);
    await expect.waitForSteps([TEAM_READ]);
    await animationFrame();
    lost.route = NAME_CREATE;
    await contains(createButton).click();
    await expect.waitForSteps(["upload_attachment", NAME_CREATE]);
    await dialogsClosed();
    expect(offlinePlugin.isOffline()).toBe(true);
    await setOffline(true);
    await settle();
    expectNothingSaved();
    // Back online, nothing of the stopped save is replayed.
    await setOffline(false);
    await settle();
    expectNothingSaved();

    // Online, a name_create refused by the server still opens the base form fallback. The
    // connection then drops and the form is closed: nothing is relinked or opened.
    await shareAgain();
    await openFormFallback();
    await setOffline(true);
    await contains(`${formDialog} .modal-header button[aria-label=Close]`).click();
    await settle();
    expectNothingSaved();
    // As in the base, closing the fallback leaves that save pending (the dialog service
    // replaces the fallback's close callback), so the share dialog stays: close it.
    expect(".o_dialog").toHaveCount(1);
    await contains(".o_dialog .modal-header button[aria-label=Close]").click();
    await dialogsClosed();

    // Online, the fallback form works as in the base: its save creates the lead, the
    // attachment is relinked to it and the lead opens.
    await setOffline(false);
    await shareAgain();
    await openFormFallback();
    await contains(`${formDialog} .o_form_button_save`).click();
    await expect.waitForSteps([WEB_SAVE, ATTACHMENT_WRITE]);
    await dialogsClosed();
    await animationFrame();
    const [lead] = MockServer.env["crm.lead"].search_read([["name", "=", "card.png"]]);
    expect(lead.team_id[0]).toBe(1);
    expect(attachmentLink()).toEqual({ res_id: lead.id, res_model: "crm.lead" });
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("card.png");
    const leadController = getService("action").currentController;
    expect(leadController.props.resId).toBe(lead.id);

    // Online, a fallback form whose web_save loses the connection: the framework queues
    // that lead save and the form reports it saved without an id. The share save then
    // resumes offline: no relink, no navigation.
    await shareAgain();
    await openFormFallback();
    lost.route = WEB_SAVE;
    await contains(`${formDialog} .o_form_button_save`).click();
    await expect.waitForSteps([WEB_SAVE]);
    await dialogsClosed();
    expect(offlinePlugin.isOffline()).toBe(true);
    await setOffline(true);
    await settle();
    expect.verifySteps([]);
    expect(getService("action").currentController).toBe(leadController);
    expect(attachmentLink()).toEqual({ res_id: lead.id, res_model: "crm.lead" });
    expect(sharedLeads()).toEqual([lead.id]);
    // The fallback form's create, with the share item's context and its default name,
    // and the new lead's delivery key.
    const [{ args, kwargs }] = queuedCalls("crm.lead");
    expect(args[1]).toMatchObject({ name: "card.png", team_id: 1 });
    const deliveryKey = kwargs.context[CRM_OFFLINE_CREATE_KEY];
    expect(deliveryKey).toMatch(/^[0-9a-f]{32}$/);
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[], args[1]],
            kwargs: {
                context: {
                    ...queuedContext({}, { ...leadItem.context, default_name: "card.png" }),
                    [CRM_OFFLINE_CREATE_KEY]: deliveryKey,
                },
                specification: {},
            },
        },
    ]);
    expect(queued("ir.attachment")).toEqual([]);
});

/** Marketing campaigns (`utm.utm_campaign_action`) with the CRM lead counters. */
const CAMPAIGN_ACTION = {
    id: 43,
    xml_id: "utm.utm_campaign_action",
    name: "Campaigns",
    res_model: "utm.campaign",
    views: [
        [false, "kanban"],
        [false, "form"],
    ],
};
defineActions([CAMPAIGN_ACTION]);

/**
 * Captures the `tag_ids` fields of leads (form and list instances), most recent last.
 *
 * @returns {Many2ManyTagsField[]}
 */
function captureLeadTagFields() {
    const tagFields = [];
    patchWithCleanup(Many2ManyTagsField.prototype, {
        setup() {
            super.setup(...arguments);
            if (this.props.record.resModel === "crm.lead" && this.props.name === "tag_ids") {
                tagFields.push(this);
            }
        },
    });
    return tagFields;
}

/** Calls the colour handlers of a lead tags field for its first tag. */
async function callTagColorHandlers(tagField, tagEl) {
    const [tagRecord] = tagField.props.record.data.tag_ids.records;
    const tag = { id: tagRecord.id, colorIndex: tagRecord.data.color };
    await tagField.onTagClick({ currentTarget: tagEl }, tagRecord);
    await tagField.switchTagColor(5, tag);
    await tagField.onTagVisibilityChange(true, tag);
}

const LEAD_FORM_TAG = ".o_form_view .o_field_widget[name=tag_ids] .o_tag:contains(Hot)";

test("[Offline] campaign and tag-colour controls inert", async () => {
    // Lost loads of the campaign card clicked offline through its lead counter.
    expect.errors(2);
    const tagFields = captureLeadTagFields();
    const setOffline = mockOffline();
    stepRoutes((route) => route.includes("/crm.tag/") || route.startsWith("/web/dataset/call_button/"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(CAMPAIGN_ACTION.id);
    await flushStartupSync();
    const counter = ".o_kanban_record a[name=action_redirect_to_leads_opportunities]";
    // On small screens the stat button sits in the button box menu, outside the form.
    const statButton = "button.oe_stat_button[name=action_redirect_to_leads_opportunities]";

    // Campaign kanban lead counter.
    expectUnguarded(counter, 1);
    await setOffline(true);
    expectGuarded(counter, 1);
    // The counter is out of hit-testing, so a pointer click on it reaches its card,
    // which the framework opens as it does on any other click of the card. The form
    // was never visited, so its load and the reload of the kanban it falls back to are
    // lost requests; the counter's own action is not issued.
    await activateByPointerAndKeyboard(counter);
    await callButton({ resModel: "utm.campaign", name: "action_redirect_to_leads_opportunities", resId: 1 });
    await settle();
    expect(currentView()).toBe("utm.utm_campaign_action/kanban");
    expect.verifySteps([]);
    expect.verifyErrors([
        "/web/dataset/call_kw/utm.campaign/web_read",
        "/web/dataset/call_kw/utm.campaign/web_search_read",
    ]);

    // Campaign form lead counter, the form being opened online.
    await setOffline(false);
    await animationFrame();
    await getService("action").switchView("form", { resId: 1 });
    await animationFrame();
    await revealFormControl(statButton);
    expectUnguarded(statButton, 1);
    await setOffline(true);
    await revealFormControl(statButton);
    expectGuarded(statButton, 1);
    await activateByPointerAndKeyboard(statButton);
    await callButton({ resModel: "utm.campaign", name: "action_redirect_to_leads_opportunities", resId: 1 });
    await settle();
    expect(currentView()).toBe("utm.utm_campaign_action/form");
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);

    // Online, both counters run their server action.
    await setOffline(false);
    await animationFrame();
    await revealFormControl(statButton);
    await contains(`${statButton}:visible`).click();
    await expect.waitForSteps([
        buttonRoute("utm.campaign", "action_redirect_to_leads_opportunities"),
        "action_redirect_to_leads_opportunities [1]",
    ]);
    await goBack();
    await contains(counter).click();
    await expect.waitForSteps([
        buttonRoute("utm.campaign", "action_redirect_to_leads_opportunities"),
        "action_redirect_to_leads_opportunities [1]",
    ]);

    // Lead tags: the list instances and the form instance (record in edition).
    await getService("action").doAction(LEADS_ACTION.id);
    await animationFrame();
    await openLead(1);
    expect(LEAD_FORM_TAG).toHaveCount(1);
    expect(LEAD_FORM_TAG).toHaveClass("o_tag_color_1");
    await setOffline(true);
    await click(queryFirst(LEAD_FORM_TAG));
    await animationFrame();
    expect(".o_tag_popover").toHaveCount(0);
    // Direct calls on every lead tags field (list rows and form): no popover, no write.
    expect(tagFields.length).toBeGreaterThan(1);
    for (const tagField of tagFields.filter(
        (tagField) => tagField.props.record.data.tag_ids.records.length
    )) {
        await callTagColorHandlers(tagField, queryFirst(LEAD_FORM_TAG));
    }
    await settle();
    expect(".o_tag_popover").toHaveCount(0);
    expect(LEAD_FORM_TAG).toHaveClass("o_tag_color_1");
    expect(queued("crm.tag")).toEqual([]);
    expect(MockServer.env["crm.tag"].browse(1)[0].color).toBe(1);
    expect.verifySteps([]);

    // Online, the popover opens and the colour is saved on the tag.
    await setOffline(false);
    await animationFrame();
    await contains(LEAD_FORM_TAG).click();
    expect(".o_tag_popover").toHaveCount(1);
    await contains(".o_tag_popover .o_colorlist_item_color_5").click();
    await expect.waitForSteps(["/web/dataset/call_kw/crm.tag/web_save"]);
    expect(".o_tag_popover").toHaveCount(0);
    expect(LEAD_FORM_TAG).toHaveClass("o_tag_color_5");
    expect(MockServer.env["crm.tag"].browse(1)[0].color).toBe(5);
});

test("[Offline] tag colour popover opened online closes and writes nothing", async () => {
    const tagFields = captureLeadTagFields();
    const setOffline = mockOffline();
    stepRoutes((route) => route.includes("/crm.tag/"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    await openLead(1);
    const formTagField = tagFields.at(-1);

    await contains(LEAD_FORM_TAG).click();
    expect(".o_tag_popover").toHaveCount(1);
    // The connection drops: the popover closes, its colours and checkbox are gone.
    await setOffline(true);
    await animationFrame();
    expect(".o_tag_popover").toHaveCount(0);
    expect(".o_colorlist").toHaveCount(0);
    // Its handlers, called directly, write nothing and reopen nothing.
    await callTagColorHandlers(formTagField, queryFirst(LEAD_FORM_TAG));
    await settle();
    expect(".o_tag_popover").toHaveCount(0);
    expect(LEAD_FORM_TAG).toHaveClass("o_tag_color_1");
    expect(queued("crm.tag")).toEqual([]);
    expect.verifySteps([]);

    // Online, the popover opens again and "Hide in Kanban" is saved on the tag.
    await setOffline(false);
    await animationFrame();
    await contains(LEAD_FORM_TAG).click();
    expect(".o_tag_popover").toHaveCount(1);
    await contains(".o_tag_popover .form-check-input").click();
    await expect.waitForSteps(["/web/dataset/call_kw/crm.tag/web_save"]);
    expect(".o_tag_popover").toHaveCount(0);
    expect(MockServer.env["crm.tag"].browse(1)[0].color).toBe(0);
});

/** Pipeline on the recurring-revenue kanban view (columns New, Qualified and Won). */
const RECURRING_PIPELINE_ACTION = {
    id: 44,
    name: "Pipeline",
    res_model: "crm.lead",
    views: [
        [RECURRING_KANBAN_VIEW_ID, "kanban"],
        [false, "form"],
    ],
    context: { default_type: "opportunity" },
};
defineActions([RECURRING_PIPELINE_ACTION]);

/**
 * Recurring-revenue (MRR) aggregate of a column header. Its tooltip is the string of
 * `recurring_revenue_monthly` ("Expected MRR"). The `MRR` label replaces it in a
 * column whose standard sum is zero.
 */
const MRR_NODE = ".o_kanban_counter .o_animated_number[data-tooltip='Expected MRR']";
const MRR_LABEL = ".o_kanban_counter b:contains(MRR)";

/**
 * Gives leads 1 and 3 (New) and 4 (Qualified) a recurring revenue, and counts the
 * recurring-revenue group probes of the columns (the user has the group).
 *
 * @returns {Promise<{ count: number }>}
 */
async function setupRecurringRevenues() {
    const probes = { count: 0 };
    const { env } = await makeMockServer();
    env["crm.lead"].write([1], { recurring_revenue_monthly: 10 });
    env["crm.lead"].write([3], { recurring_revenue_monthly: 5 });
    env["crm.lead"].write([4], { recurring_revenue_monthly: 20 });
    patchWithCleanup(user, {
        hasGroup(group) {
            if (group === "crm.group_use_recurring_revenues") {
                probes.count++;
                return Promise.resolve(true);
            }
            return super.hasGroup(...arguments);
        },
    });
    return probes;
}

/**
 * Opens the recurring-revenue pipeline online (its columns probe the group and show
 * the aggregate), then a lead form, then goes offline and back to the pipeline: the
 * kanban view is mounted offline from the cache.
 *
 * @param {(offline: boolean) => Promise<void>} setOffline
 * @param {{ count: number }} probes
 */
async function mountRecurringPipelineOffline(setOffline, probes) {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(RECURRING_PIPELINE_ACTION.id);
    await flushStartupSync();
    expect(probes.count).toBeGreaterThan(0);
    expect(queryAllTexts(MRR_NODE)).toEqual(["+15", "+20"]);
    await contains(".o_kanban_record:contains(Lead 1)").click();
    await expectCurrentView(`${RECURRING_PIPELINE_ACTION.id}/form`);
    probes.count = 0;
    await setOffline(true);
    await goBack();
    await expectCurrentView(`${RECURRING_PIPELINE_ACTION.id}/kanban`);
    await animationFrame();
}

test("[Offline] recurring revenue aggregate hidden, probe skipped", async () => {
    // Offline root load served from the cache: the pipeline groups.
    expect.errors(1);
    const setOffline = mockOffline();
    const probes = await setupRecurringRevenues();
    await mountRecurringPipelineOffline(setOffline, probes);
    // The columns render without the MRR aggregate (absent, not a zero), and no
    // column probed the group.
    expect(".o_kanban_group").toHaveCount(3);
    expect(".o_kanban_counter").toHaveCount(3);
    expect(MRR_NODE).toHaveCount(0);
    expect(MRR_LABEL).toHaveCount(0);
    await settle();
    expect(probes.count).toBe(0);
    expect.verifyErrors([LEAD_GROUPS_LOAD]);
});

test("[Offline] recurring revenue hidden after disconnect and restored online", async () => {
    const setOffline = mockOffline();
    const probes = await setupRecurringRevenues();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(RECURRING_PIPELINE_ACTION.id);
    await flushStartupSync();
    expect(probes.count).toBeGreaterThan(0);
    expect(queryAllTexts(MRR_NODE)).toEqual(["+15", "+20"]);
    probes.count = 0;

    // The connection drops: the aggregate disappears at once, without a probe.
    await setOffline(true);
    expect(".o_kanban_group").toHaveCount(3);
    expect(MRR_NODE).toHaveCount(0);
    expect(MRR_LABEL).toHaveCount(0);

    // Back online: the aggregate is shown again from the earlier probe result.
    await setOffline(false);
    await animationFrame();
    expect(queryAllTexts(MRR_NODE)).toEqual(["+15", "+20"]);
    await settle();
    expect(probes.count).toBe(0);
});

test("[Offline] recurring revenue probe runs on reconnect after an offline mount", async () => {
    // Offline root load served from the cache: the pipeline groups.
    expect.errors(1);
    let kanbanController = null;
    patchWithCleanup(registry.category("views").get("crm_kanban").Controller.prototype, {
        setup() {
            super.setup(...arguments);
            kanbanController = this;
        },
    });
    const setOffline = mockOffline();
    const probes = await setupRecurringRevenues();
    await mountRecurringPipelineOffline(setOffline, probes);
    expect(MRR_NODE).toHaveCount(0);
    expect(probes.count).toBe(0);
    expect.verifyErrors([LEAD_GROUPS_LOAD]);

    // On reconnection each column issues its deferred probe once. A column mounted
    // offline holds no aggregate values until the next online load (framework
    // progress-bar data): still no MRR node, and no zero either.
    await setOffline(false);
    await settle();
    expect(probes.count).toBe(3);
    expect(MRR_NODE).toHaveCount(0);
    expect(MRR_LABEL).toHaveCount(0);
    // The next online load shows the aggregate from the deferred probe results.
    kanbanController.env.searchModel.search();
    await settle();
    expect(queryAllTexts(MRR_NODE)).toEqual(["+15", "+20"]);
    expect(probes.count).toBe(3);
    // A later disconnection and reconnection does not probe again.
    await setOffline(true);
    expect(MRR_NODE).toHaveCount(0);
    await setOffline(false);
    await settle();
    expect(queryAllTexts(MRR_NODE)).toEqual(["+15", "+20"]);
    expect(probes.count).toBe(3);
});

/** Autocomplete dropdown of the lead form partner field. */
const PARTNER_INPUT = ".o_form_view .o_field_widget[name=partner_id] input";
const PARTNER_OPTIONS = ".o-autocomplete--dropdown-item";
const ENRICHMENT_OPTION = ".o-autocomplete--dropdown-item.partner_autocomplete_dropdown_many2one";
const SEARCH_WORLDWIDE = ".o-autocomplete--dropdown-item:contains(Search Worldwide)";
const ENRICHMENT_LOADING =
    ".o-autocomplete--dropdown-menu .o_loading:contains(Searching Autocomplete)";

/**
 * Creates the partner "Azure Interior" and the enrichment lookup, then opens lead 1
 * in the full lead form. The lookup steps its query and country (`false` or `0`
 * worldwide); while `lookupGate.promise` is set, the lookup answers once it resolves.
 *
 * @param {{ promise?: Promise<void> }} [lookupGate]
 * @returns {Promise<number>} the partner id
 */
async function openLeadWithPartnerField(lookupGate = {}) {
    const { env } = await makeMockServer();
    const partnerId = env["res.partner"].create({ name: "Azure Interior" });
    onRpc("res.partner", "autocomplete_by_name", async ({ args }) => {
        expect.step(`autocomplete_by_name ${args[0]} ${args[1]}`);
        await lookupGate.promise;
        return [{ name: "Azure Interior SA", vat: "BE0477472701" }];
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    await openLead(1);
    return partnerId;
}

/** Types a partner query and lets the autocomplete load its sources. */
async function searchPartner(query) {
    await contains(PARTNER_INPUT).edit(query, { confirm: false });
    await runAllTimers();
    await animationFrame();
}

test.tags("desktop");
test("[Offline] partner field searches cache, no enrichment lookup, no create", async () => {
    const setOffline = mockOffline();
    stepRoutes((route) => route.includes("/res.partner/"));
    const autoCompletes = [];
    patchWithCleanup(PartnerAutoCompleteStandIn.prototype, {
        setup() {
            super.setup(...arguments);
            autoCompletes.push(this);
        },
    });
    const lookupGate = {};
    const partnerId = await openLeadWithPartnerField(lookupGate);
    // Online, a search caches the matching partner (and offers enrichment, the
    // worldwide search and creation).
    await searchPartner("Azu");
    expect.verifySteps([
        JSVAT_SCRIPT,
        "/web/dataset/call_kw/res.partner/autocomplete_by_name",
        "/web/dataset/call_kw/res.partner/web_name_search",
        "autocomplete_by_name Azu false",
    ]);
    expect(queryAllTexts(PARTNER_OPTIONS)).toInclude("Azure Interior");
    expect(ENRICHMENT_OPTION).toHaveCount(1);
    expect(SEARCH_WORLDWIDE).toHaveCount(1);
    expect(queryAllTexts(PARTNER_OPTIONS).some((text) => text.startsWith("Create"))).toBe(true);
    // In the dropdown opened online, the worldwide search is removed when the
    // connection drops (the enrichment suggestion turns inert) and is back online.
    await setOffline(true);
    expect(SEARCH_WORLDWIDE).toHaveCount(0);
    expect(ENRICHMENT_OPTION).toHaveClass("o_disabled_offline");
    await setOffline(false);
    expect(SEARCH_WORLDWIDE).toHaveCount(1);
    expect(ENRICHMENT_OPTION).not.toHaveClass("o_disabled_offline");
    await press("Escape");
    await contains(PARTNER_INPUT).clear({ confirm: false });
    await animationFrame();

    // An enrichment lookup still pending when the connection drops shows no loading
    // row offline, and shows it again online while it is still pending.
    const pendingLookup = Promise.withResolvers();
    lookupGate.promise = pendingLookup.promise;
    await searchPartner("Azur");
    expect.verifySteps([
        JSVAT_SCRIPT,
        "/web/dataset/call_kw/res.partner/autocomplete_by_name",
        "/web/dataset/call_kw/res.partner/web_name_search",
        "autocomplete_by_name Azur false",
    ]);
    expect(ENRICHMENT_LOADING).toHaveCount(1);
    await setOffline(true);
    expect(ENRICHMENT_LOADING).toHaveCount(0);
    expect(SEARCH_WORLDWIDE).toHaveCount(0);
    expect(queryAllTexts(PARTNER_OPTIONS)).toInclude("Azure Interior");
    await setOffline(false);
    expect(ENRICHMENT_LOADING).toHaveCount(1);
    lookupGate.promise = null;
    pendingLookup.resolve();
    await animationFrame();
    expect(ENRICHMENT_LOADING).toHaveCount(0);
    expect(ENRICHMENT_OPTION).toHaveCount(1);
    expect(SEARCH_WORLDWIDE).toHaveCount(1);
    await press("Escape");
    await contains(PARTNER_INPUT).clear({ confirm: false });
    await animationFrame();

    // Offline: a new query (not the memoized one) is answered from the relational-field
    // cache alone, with no request attempted: no record search, no enrichment script or
    // lookup, no worldwide search, and no Create, Create and edit or Search more.
    await setOffline(true);
    // Registered after `mockOffline()`: records every route the search attempts,
    // including those the lost network refuses.
    const attemptedRoutes = [];
    let trackingAttempts = true;
    onRpc("/*", (request) => {
        if (trackingAttempts) {
            attemptedRoutes.push(new URL(request.url).pathname);
        }
    });
    // Past the autocomplete debounce only: the offline plugin's own connection check
    // (a timer) is not part of the search.
    await contains(PARTNER_INPUT).edit("Nobody", { confirm: false });
    await advanceTime(500);
    await animationFrame();
    expect(queryAllTexts(PARTNER_OPTIONS)).toEqual(["No records"]);
    expect(SEARCH_WORLDWIDE).toHaveCount(0);
    await contains(PARTNER_INPUT).edit("Interior", { confirm: false });
    await advanceTime(500);
    await animationFrame();
    expect(queryAllTexts(PARTNER_OPTIONS)).toEqual(["Azure Interior"]);
    expect(ENRICHMENT_OPTION).toHaveCount(0);
    expect(SEARCH_WORLDWIDE).toHaveCount(0);
    expect(".o_m2o_dropdown_option").toHaveCount(0);
    // Called directly, the worldwide search does nothing but prevent its event's
    // default action: the open dropdown is neither closed nor reloaded, a closed one
    // stays closed, and the flag is not remembered for the next online lookup
    // (checked below).
    const partnerAutoComplete = autoCompletes.findLast((autoComplete) =>
        autoComplete.inputRef()?.closest(".o_field_widget[name=partner_id]")
    );
    // Unguarded, the worldwide search would reopen the dropdown at once (no input
    // debounce), so no time is advanced: the offline plugin's connection check (a
    // timer) stays out.
    const callSearchWorldwide = async () => {
        const event = new MouseEvent("click", { cancelable: true });
        await partnerAutoComplete.searchWorldwide(event);
        await animationFrame();
        expect(event.defaultPrevented).toBe(true);
    };
    // Offline, the record source is the only one.
    const [loadedSource] = partnerAutoComplete.sources;
    const loadedOptionIds = loadedSource.options.map(({ id }) => id);
    await callSearchWorldwide();
    expect(".o-autocomplete--dropdown-menu").toHaveCount(1);
    expect(partnerAutoComplete.sources).toHaveLength(1);
    expect(partnerAutoComplete.sources[0]).toBe(loadedSource);
    expect(loadedSource.options.map(({ id }) => id)).toEqual(loadedOptionIds);
    expect(queryAllTexts(PARTNER_OPTIONS)).toEqual(["Azure Interior"]);
    expect(SEARCH_WORLDWIDE).toHaveCount(0);
    // The cached partner is selected, which closes the dropdown.
    await contains(`${PARTNER_OPTIONS}:contains(Azure Interior)`).click();
    expect(PARTNER_INPUT).toHaveValue("Azure Interior");
    expect(".o-autocomplete--dropdown-menu").toHaveCount(0);
    await callSearchWorldwide();
    expect(".o-autocomplete--dropdown-menu").toHaveCount(0);
    expect(PARTNER_INPUT).toHaveValue("Azure Interior");
    expect(attemptedRoutes).toEqual([]);
    trackingAttempts = false;
    expect.verifySteps([]);
    // The selected partner is saved through the queue.
    await contains(".o_form_button_save").click();
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { partner_id: partnerId }],
            kwargs: { context: queuedContext(LEADS_ACTION.context), specification: {} },
        },
    ]);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);

    // Online again, the next lookup still searches the company's country (`false`),
    // and the worldwide search is offered again.
    await reconnect(setOffline);
    await searchPartner("Azure");
    expect.verifySteps([
        JSVAT_SCRIPT,
        "/web/dataset/call_kw/res.partner/autocomplete_by_name",
        "/web/dataset/call_kw/res.partner/web_name_search",
        "autocomplete_by_name Azure false",
    ]);
    expect(SEARCH_WORLDWIDE).toHaveCount(1);
});

test.tags("desktop");
test("[Online] partner field keeps enrichment source", async () => {
    stepRoutes((route) => route.includes("/res.partner/"));
    await openLeadWithPartnerField();
    // Two characters: the record search only, with no suggestion to search worldwide.
    await searchPartner("Az");
    expect.verifySteps(["/web/dataset/call_kw/res.partner/web_name_search"]);
    expect(ENRICHMENT_OPTION).toHaveCount(0);
    expect(SEARCH_WORLDWIDE).toHaveCount(0);
    // Three characters: the enrichment source loads its script and looks the name up
    // in the company's country (`false`), and the worldwide search is offered.
    await searchPartner("Azu");
    expect.verifySteps([
        JSVAT_SCRIPT,
        "/web/dataset/call_kw/res.partner/autocomplete_by_name",
        "/web/dataset/call_kw/res.partner/web_name_search",
        "autocomplete_by_name Azu false",
    ]);
    expect(ENRICHMENT_OPTION).toHaveCount(1);
    expect(ENRICHMENT_OPTION).toHaveText("Azure Interior SA");
    expect(`${SEARCH_WORLDWIDE} a[role=option]`).toHaveCount(1);
    // "Search Worldwide" looks the name up again in every country (`0`), then hides.
    await contains(SEARCH_WORLDWIDE).click();
    await runAllTimers();
    await animationFrame();
    expect.verifySteps([
        JSVAT_SCRIPT,
        "/web/dataset/call_kw/res.partner/autocomplete_by_name",
        "autocomplete_by_name Azu 0",
    ]);
    expect(SEARCH_WORLDWIDE).toHaveCount(0);
    expect(ENRICHMENT_OPTION).toHaveCount(1);
    await contains(ENRICHMENT_OPTION).click();
    expect.verifySteps(["enrichment selected: Azure Interior SA"]);
});

/**
 * Records every `/mail/` route requested (thread fetches, store fetches, posts).
 * Registered after `mockOffline()`, it also sees the requests attempted offline.
 *
 * @returns {string[]}
 */
function trackMailRequests() {
    const routes = [];
    onRpc("/*", (request) => {
        const route = new URL(request.url).pathname;
        if (route.startsWith("/mail/")) {
            routes.push(route);
        }
    });
    return routes;
}

/**
 * Records the lead thread fetches the store sends (`/mail/store` fetch parameters
 * naming a `crm.lead` thread), as `"<name> <thread id>"`.
 *
 * @returns {string[]}
 */
function trackLeadThreadFetches() {
    const fetches = [];
    onRpc("/mail/store", async (request) => {
        const { params } = await request.json();
        for (const fetchParam of params.fetch_params) {
            const [name, fetchParams] = typeof fetchParam === "string" ? [fetchParam] : fetchParam;
            if (fetchParams?.thread_model === "crm.lead") {
                fetches.push(`${name} ${fetchParams.thread_id}`);
            }
        }
    });
    return fetches;
}

/** Chatter top-bar controls: Send message, Log note, Activities, attach, followers. */
const CHATTER_BUTTONS = [
    ".o-mail-Chatter-sendMessage",
    ".o-mail-Chatter-logNote",
    ".o-mail-Chatter-activity",
    ".o-mail-Chatter-attachFiles",
    ".o-mail-Followers-button",
];

test("[Offline] lead form chatter is read-only without error", async () => {
    // Offline root load served from the cache: the reopened lead.
    expect.errors(1);
    const pyEnv = await startServer();
    pyEnv["mail.message"].create({
        author_id: serverState.partnerId,
        body: "Kick-off call done",
        message_type: "comment",
        model: "crm.lead",
        res_id: 1,
    });
    const setOffline = mockOffline();
    const mailRequests = trackMailRequests();
    const stepping = stepRoutes();
    stepping.active = false;
    await start();
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    await openLead(1);
    await waitFor(".o-mail-Message:contains(Kick-off call done)");
    // Online, the thread is fetched through the store (`/mail/store`).
    expect(mailRequests).toInclude("/mail/store");
    for (const button of CHATTER_BUTTONS) {
        expect(button).toBeEnabled();
    }
    await goBack();
    mailRequests.length = 0;

    // Offline, the reopened lead's chatter fetches nothing, shows the messages
    // already in the store and its controls are disabled.
    await setOffline(true);
    await openLead(1);
    await settle();
    expect(".o-mail-Message:contains(Kick-off call done)").toHaveCount(1);
    for (const button of CHATTER_BUTTONS) {
        expect(button).not.toBeEnabled();
    }
    expect(".o-mail-Composer").toHaveCount(0);
    expect(mailRequests).toEqual([]);
    expect.verifyErrors([LEAD_RECORD_LOAD]);
    // Their pointer, Enter and Space activations and the Send message (Alt+M), Log
    // note (Alt+Shift+M) and Activities (Alt+Shift+A) hotkeys open no composer and
    // no activity dialog, and request or queue nothing.
    stepping.active = true;
    for (const button of CHATTER_BUTTONS) {
        await activateByPointerAndKeyboard(button);
    }
    for (const hotkey of [
        ["alt", "m"],
        ["alt", "shift", "m"],
        ["alt", "shift", "a"],
    ]) {
        await press(hotkey);
        await settle();
    }
    expect(".o-mail-Composer").toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect(mailRequests).toEqual([]);
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);
    expect.verifySteps([]);
    stepping.active = false;

    // Online, the controls are enabled again: Send message opens the composer, and
    // so do the hotkeys of Log note and Send message; that of Activities opens the
    // activity schedule dialog.
    await setOffline(false);
    await settle();
    for (const button of CHATTER_BUTTONS) {
        expect(button).toBeEnabled();
    }
    await contains(".o-mail-Chatter-sendMessage").click();
    expect(".o-mail-Composer-input").toHaveCount(1);
    await press(["alt", "shift", "m"]);
    await settle();
    expect(".o-mail-Chatter-logNote").toHaveClass("active");
    expect(".o-mail-Composer-input").toHaveCount(1);
    await press(["alt", "m"]);
    await settle();
    expect(".o-mail-Chatter-sendMessage").toHaveClass("active");
    expect(".o-mail-Chatter-logNote").not.toHaveClass("active");
    expect(".o-mail-Composer-input").toHaveCount(1);
    await press(["alt", "shift", "a"]);
    await settle();
    expect(".modal .o_form_view").toHaveCount(1);
});

// Refine D2.1 (U1): a lead chatter first opened offline loads once on reconnection.

/**
 * A connection lost without the browser announcing it: while `lost` is set, every
 * request waits until `drop()` is called, then fails as a dead network does (`502`,
 * a `ConnectionLostError`), so the framework learns of the loss only from those
 * failures. Must be called after `mockOffline()`, and before the request trackers
 * that must also see the requests it fails.
 *
 * @returns {{ lost: boolean, drop: () => void }}
 */
function mockUnnoticedConnectionLoss() {
    const dropped = Promise.withResolvers();
    const connection = { lost: false, drop: () => dropped.resolve() };
    onRpc("/*", async () => {
        if (connection.lost) {
            await dropped.promise;
            return new Response("", { status: 502 });
        }
    });
    return connection;
}

/** Lead 1 with a message, its follower and an attachment, for the chatter loads. */
async function startLeadThreadServer() {
    const pyEnv = await startServer();
    pyEnv["mail.message"].create({
        author_id: serverState.partnerId,
        body: "Kick-off call done",
        message_type: "comment",
        model: "crm.lead",
        res_id: 1,
    });
    pyEnv["mail.followers"].create({
        partner_id: serverState.partnerId,
        res_id: 1,
        res_model: "crm.lead",
    });
    pyEnv["ir.attachment"].create({
        mimetype: "text/plain",
        name: "brief.txt",
        res_id: 1,
        res_model: "crm.lead",
    });
    return pyEnv;
}

/**
 * Opens lead 1 online, which caches its form, and goes back; then, as after a new
 * page load, removes its thread from the store, so the lead's next chatter is the
 * first to show it.
 */
async function visitLeadThenForgetThread() {
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    await openLead(1);
    await waitFor(".o-mail-Message:contains(Kick-off call done)");
    await goBack();
    getService("mail.store")["mail.thread"].get({ model: "crm.lead", id: 1 }).delete();
}

/**
 * Back online, the displayed lead's thread is loaded: its message, its follower
 * count and enabled controls, and no loading spinner is left (follower count,
 * attachments).
 */
async function expectLeadThreadLoaded() {
    await waitFor(".o-mail-Message:contains(Kick-off call done)");
    await waitFor(".o-mail-Followers-counter:contains(1)");
    await settle();
    expect(".o-mail-Chatter .fa-spin").toHaveCount(0);
    for (const button of CHATTER_BUTTONS) {
        expect(button).toBeEnabled();
    }
    const thread = getService("mail.store")["mail.thread"].get({ model: "crm.lead", id: 1 });
    expect(thread.followersCount).toBe(1);
    expect(thread.isLoadingAttachments).toBe(false);
    expect(thread.hasLoadingFailed).toBe(false);
}

test("[Offline] lead chatter first opened offline loads once on reconnection", async () => {
    // Offline root load served from the cache: the reopened lead.
    expect.errors(1);
    const chatters = [];
    patchWithCleanup(Chatter.prototype, {
        setup() {
            super.setup(...arguments);
            chatters.push(this);
        },
    });
    const pyEnv = await startLeadThreadServer();
    const partnerId = pyEnv["res.partner"].create({ name: "Azure Interior" });
    pyEnv["mail.message"].create({
        author_id: serverState.partnerId,
        body: "Partner note",
        message_type: "comment",
        model: "res.partner",
        res_id: partnerId,
    });
    const setOffline = mockOffline();
    const mailRequests = trackMailRequests();
    await start();
    await visitLeadThenForgetThread();
    const threadFetches = trackLeadThreadFetches();
    mailRequests.length = 0;

    // Offline, the lead's chatter is the first to show its thread: it requests
    // nothing, and shows neither a message nor a loading spinner.
    await setOffline(true);
    await openLead(1);
    await settle();
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Lead 1");
    expect(".o-mail-Message").toHaveCount(0);
    await advanceTime(10000);
    await animationFrame();
    expect(".o-mail-Chatter .fa-spin").toHaveCount(0);
    expect(mailRequests).toEqual([]);
    expect.verifyErrors([LEAD_RECORD_LOAD]);

    // Back online, its thread loads once (messages and thread data in one store
    // request), without reopening the lead.
    await setOffline(false);
    await expectLeadThreadLoaded();
    expect(mailRequests).toEqual(["/mail/store"]);
    expect(threadFetches.sort()).toEqual(["/mail/thread/messages 1", "mail.thread 1"]);

    // A later disconnection and reconnection fetch nothing more.
    await setOffline(true);
    await settle();
    await setOffline(false);
    await settle();
    expect(mailRequests).toEqual(["/mail/store"]);
    expect(".o-mail-Message:contains(Kick-off call done)").toHaveCount(1);

    // Another model's chatter is untouched: offline, its load runs mail's code, which
    // requests its thread (and fails), and nothing is loaded for it on reconnection.
    await getService("action").doAction({
        type: "ir.actions.act_window",
        res_model: "res.partner",
        res_id: partnerId,
        views: [[false, "form"]],
    });
    await waitFor(".o-mail-Message:contains(Partner note)");
    const partnerChatter = chatters.findLast(
        (chatter) => chatter.state.thread?.model === "res.partner"
    );
    mailRequests.length = 0;
    await setOffline(true);
    await expect(partnerChatter.load(partnerChatter.state.thread, ["followers"])).rejects.toThrow(
        ConnectionLostError
    );
    expect(mailRequests).toEqual(["/mail/store"]);
    await setOffline(false);
    await settle();
    expect(mailRequests).toEqual(["/mail/store"]);
});

test("[Offline] lead chatter opened as the connection drops loads once on reconnection", async () => {
    // The dead connection's failure of the reopened lead's root load, served from the
    // cache.
    expect.errors(1);
    await startLeadThreadServer();
    const setOffline = mockOffline();
    const connection = mockUnnoticedConnectionLoss();
    const mailRequests = trackMailRequests();
    await start();
    await visitLeadThenForgetThread();
    mailRequests.length = 0;

    // The connection is lost unnoticed: the lead opens from the cache, and its
    // chatter, mounted while the framework still reports online, requests its thread.
    connection.lost = true;
    await openLead(1);
    await waitUntil(() => mailRequests.includes("/mail/store"));
    expect(getService(OfflinePlugin).isOffline()).toBe(false);
    // A dead network takes a while to fail its requests: meanwhile the chatter shows
    // its follower count, and one second into the load its attachments, as loading.
    await advanceTime(1500);
    await animationFrame();
    expect(".o-mail-Followers-button .fa-spin").toHaveCount(1);
    expect(".o-mail-Chatter-attachFiles .fa-spin").toHaveCount(1);
    // Those requests fail, and the framework goes offline: the lead's chatter raises
    // nothing and shows no loading spinner, as when its load is skipped offline.
    connection.drop();
    await settle();
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Lead 1");
    expect(".o-mail-Message").toHaveCount(0);
    expect(".o-mail-Chatter .fa-spin").toHaveCount(0);
    expect.verifyErrors([LEAD_RECORD_LOAD]);
    const threadFetches = trackLeadThreadFetches();
    mailRequests.length = 0;

    // Back online, the lost thread load is run once, without reopening the lead.
    connection.lost = false;
    await setOffline(false);
    await expectLeadThreadLoaded();
    expect(mailRequests).toEqual(["/mail/store"]);
    expect(threadFetches.sort()).toEqual(["/mail/thread/messages 1", "mail.thread 1"]);

    // A later disconnection and reconnection fetch nothing more.
    await setOffline(true);
    await settle();
    await setOffline(false);
    await settle();
    expect(mailRequests).toEqual(["/mail/store"]);
    expect(".o-mail-Message:contains(Kick-off call done)").toHaveCount(1);
});

test("[Offline] open lead composer posts nothing after disconnect", async () => {
    const composers = [];
    patchWithCleanup(Composer.prototype, {
        setup() {
            super.setup(...arguments);
            composers.push(this);
        },
    });
    const pyEnv = await startServer();
    pyEnv["mail.message"].create({
        author_id: serverState.partnerId,
        body: "Kick-off call done",
        message_type: "comment",
        model: "crm.lead",
        res_id: 1,
    });
    const setOffline = mockOffline();
    const mailRequests = trackMailRequests();
    await start();
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    await openLead(1);
    await waitFor(".o-mail-Message:contains(Kick-off call done)");
    // The composer is opened online and a message typed.
    await contains(".o-mail-Chatter-sendMessage").click();
    await contains(".o-mail-Composer-input").edit("Offline hello", { confirm: false });
    const composer = composers.find(
        (candidate) => candidate.props.composer?.thread?.model === "crm.lead"
    );
    expect(Boolean(composer)).toBe(true);
    mailRequests.length = 0;

    // The connection drops: the composer closes; Ctrl+Enter and direct calls of its
    // keyboard and send handlers post nothing.
    await setOffline(true);
    await animationFrame();
    expect(".o-mail-Composer").toHaveCount(0);
    await press(["control", "Enter"]);
    composer.onKeydown(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    await composer.sendMessage();
    // Nor does Meta+Enter, the posting shortcut on macOS (the composer reads the
    // platform on each key press).
    mockUserAgent("mac");
    await press(["meta", "Enter"]);
    composer.onKeydown(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    await settle();
    expect(mailRequests).toEqual([]);
    expect(".o-mail-Message:contains(Offline hello)").toHaveCount(0);
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);

    // Online, the composer posts again: with Meta+Enter on macOS...
    await setOffline(false);
    await settle();
    await contains(".o-mail-Chatter-sendMessage").click();
    await contains(".o-mail-Composer-input").edit("Online mac hello", { confirm: false });
    await press(["meta", "Enter"]);
    await waitUntil(() => mailRequests.includes("/mail/message/post"));
    await waitFor(".o-mail-Message:contains(Online mac hello)");
    // ... and with Ctrl+Enter on the other platforms.
    mockUserAgent("linux");
    mailRequests.length = 0;
    // The chatter closes its composer once the message is posted.
    await waitUntil(() => !queryAll(".o-mail-Composer-input").length);
    await contains(".o-mail-Chatter-sendMessage").click();
    await contains(".o-mail-Composer-input").edit("Online hello", { confirm: false });
    await press(["control", "Enter"]);
    await waitUntil(() => mailRequests.includes("/mail/message/post"));
    await waitFor(".o-mail-Message:contains(Online hello)");
});

test("[Offline] lead chatter activity scheduling opens nothing", async () => {
    const chatters = [];
    patchWithCleanup(Chatter.prototype, {
        setup() {
            super.setup(...arguments);
            chatters.push(this);
        },
    });
    /** The last lead chatter mounted (the displayed one). */
    const leadChatter = () =>
        chatters.findLast((chatter) => chatter.state.thread?.model === "crm.lead");
    await startServer();
    const setOffline = mockOffline();
    const mailRequests = trackMailRequests();
    const stepping = stepRoutes();
    stepping.active = false;
    await start();
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    await openLead(1);
    await waitFor(".o-mail-Chatter-activity:enabled");
    const chatter = leadChatter();
    expect(chatter.state.thread.id).toBe(1);
    await settle();
    mailRequests.length = 0;

    // Offline, a forced click of the disabled Activity button and a direct call of
    // its handler open no activity dialog, and request, queue and raise nothing.
    await setOffline(true);
    stepping.active = true;
    forceClick(".o-mail-Chatter-activity");
    await chatter.scheduleActivity();
    await settle();
    expect(".modal").toHaveCount(0);
    expect(mailRequests).toEqual([]);
    expect.verifySteps([]);
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);
    stepping.active = false;

    // Online, the same call opens the activity schedule dialog.
    await setOffline(false);
    await settle();
    await chatter.scheduleActivity();
    await waitFor(".modal .o_form_view");
    await contains(".modal button[aria-label=Close]:visible").click();
    await settle();
    expect(".modal").toHaveCount(0);

    // A new lead, named online: offline, scheduling its activity does not save it
    // (no queued create to get a thread) and opens nothing.
    await goBack();
    await getService("action").switchView("form");
    await animationFrame();
    await contains(".o_field_widget[name=name] input").edit("Unsaved lead");
    await waitFor(".o-mail-Chatter-activity:enabled");
    const newLeadChatter = leadChatter();
    expect(newLeadChatter.state.thread.id).toBe(false);
    await settle();
    mailRequests.length = 0;
    await setOffline(true);
    stepping.active = true;
    forceClick(".o-mail-Chatter-activity");
    await newLeadChatter.scheduleActivity();
    await settle();
    expect(".modal").toHaveCount(0);
    expect(mailRequests).toEqual([]);
    expect.verifySteps([]);
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);
    expect(newLeadChatter.state.thread.id).toBe(false);
    expect(".o_field_widget[name=name] input").toHaveValue("Unsaved lead");
});

test("[Offline] lead followers menu opened online closes and its handlers request nothing", async () => {
    // The real chatter, followers menu, follower and subtype dialog instances.
    const chatters = [];
    const followerLists = [];
    const followers = [];
    const subtypeDialogs = [];
    for (const [Component, instances] of [
        [Chatter, chatters],
        [FollowerList, followerLists],
        [Follower, followers],
        [FollowerSubtypeDialog, subtypeDialogs],
    ]) {
        patchWithCleanup(Component.prototype, {
            setup() {
                super.setup(...arguments);
                instances.push(this);
            },
        });
    }
    const pyEnv = await startServer();
    const subtypeId = pyEnv["mail.message.subtype"].create({ default: true, name: "Discussions" });
    const otherPartnerId = pyEnv["res.partner"].create({ name: "Bob Follower" });
    pyEnv["mail.followers"].create([
        {
            partner_id: serverState.partnerId,
            res_id: 1,
            res_model: "crm.lead",
            subtype_ids: [subtypeId],
        },
        { partner_id: otherPartnerId, res_id: 1, res_model: "crm.lead", subtype_ids: [subtypeId] },
    ]);
    /** The lead's followers on the server, as `[partner id, subtype ids]`. */
    const serverFollowers = () =>
        pyEnv["mail.followers"]
            .browse(
                pyEnv["mail.followers"].search([
                    ["res_model", "=", "crm.lead"],
                    ["res_id", "=", 1],
                ])
            )
            .map(({ partner_id, subtype_ids }) => [partner_id, [...subtype_ids]]);
    const onlineFollowers = serverFollowers();
    expect(onlineFollowers).toEqual([
        [serverState.partnerId, [subtypeId]],
        [otherPartnerId, [subtypeId]],
    ]);
    const setOffline = mockOffline();
    const mailRequests = trackMailRequests();
    const stepping = stepRoutes();
    stepping.active = false;
    await start();
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    await openLead(1);
    await waitFor(".o-mail-Followers-counter:contains(2)");
    const chatter = chatters.findLast((candidate) => candidate.state.thread?.model === "crm.lead");

    // Online, the followers menu (a bottom sheet with touch) offers Unfollow (the
    // self follower) and Add Followers, and lists the other follower.
    const menu = ".o-mail-Followers-dropdown";
    await contains(".o-mail-Followers-button").click();
    await waitFor(`${menu} .o-mail-Follower:contains(Bob Follower)`);
    expect(".o_bottom_sheet").toHaveCount(isSmall() ? 1 : 0);
    expect(`${menu} .o-mail-FollowerList-unfollow`).toHaveCount(1);
    expect(`${menu} .o-dropdown-item:contains(Add Followers)`).toHaveCount(1);
    const followerList = followerLists.at(-1);
    expect(followerList.props.thread.model).toBe("crm.lead");
    const leadFollowers = followers.filter(
        (follower) => follower.props.follower.thread?.model === "crm.lead"
    );
    expect(leadFollowers.map((follower) => follower.props.follower.partner_id.id)).toEqual([
        otherPartnerId,
    ]);
    await settle();
    mailRequests.length = 0;

    // The connection drops: the menu opened online closes. Forced open offline, by a
    // click of its disabled button or through its state, it closes again.
    await setOffline(true);
    await settle();
    expect(menu).toHaveCount(0);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(chatter.followerListDropdown.isOpen).toBe(false);
    stepping.active = true;
    forceClick(".o-mail-Followers-button");
    await settle();
    expect(menu).toHaveCount(0);
    chatter.followerListDropdown.open();
    await settle();
    expect(menu).toHaveCount(0);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(chatter.followerListDropdown.isOpen).toBe(false);

    // Offline, direct calls of the menu's handlers (Follow, Unfollow, Add Followers,
    // the self follower's preferences) and of each follower's (details, preferences,
    // removal) request, open, queue and change nothing, and raise no error.
    await followerList.onClickFollow();
    await followerList.onClickUnfollow();
    followerList.onClickAddFollowers();
    await followerList.onClickEdit();
    for (const follower of leadFollowers) {
        follower.onClickDetails({ currentTarget: queryFirst(".o-mail-Followers-button") });
        await follower.onClickEdit();
        await follower.onClickRemove();
    }
    await settle();
    expect(".modal").toHaveCount(0);
    expect(".o_avatar_card").toHaveCount(0);
    expect(mailRequests).toEqual([]);
    expect.verifySteps([]);
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);
    expect(serverFollowers()).toEqual(onlineFollowers);
    stepping.active = false;

    // A follower's preferences dialog opened online: offline, applying it, with its
    // subtype kept (a subscription call) or unchecked (a removal), requests and
    // changes nothing, and the dialog stays open until it is closed.
    await setOffline(false);
    await settle();
    await contains(".o-mail-Followers-button").click();
    await contains(
        `${menu} .o-mail-Follower:contains(Bob Follower) [title='Edit Notification Preferences']`
    ).click();
    const subtypeCheckbox = `.o-mail-FollowerSubtypeDialog-subtype[data-follower-subtype-id='${subtypeId}'] input`;
    await waitFor(`${subtypeCheckbox}:checked`);
    const subtypeDialog = subtypeDialogs.at(-1);
    expect(subtypeDialog.props.follower.partner_id.id).toBe(otherPartnerId);
    await settle();
    mailRequests.length = 0;
    await setOffline(true);
    await settle();
    stepping.active = true;
    expect(".o-mail-FollowerSubtypeDialog button.btn-primary").not.toBeEnabled();
    await subtypeDialog.onClickApply();
    await contains(subtypeCheckbox).click();
    await subtypeDialog.onClickApply();
    await settle();
    expect(".o-mail-FollowerSubtypeDialog").toHaveCount(1);
    expect(mailRequests).toEqual([]);
    expect.verifySteps([]);
    expect(serverFollowers()).toEqual(onlineFollowers);
    stepping.active = false;
    await contains(".modal button[aria-label=Close]:visible").click();
    expect(".modal").toHaveCount(0);

    // Online, the menu works again: Unfollow, Follow, and Add Followers opens its
    // wizard.
    await setOffline(false);
    await settle();
    mailRequests.length = 0;
    await contains(".o-mail-Followers-button").click();
    await contains(`${menu} .o-mail-FollowerList-unfollowBtn`).click();
    await waitFor(".o-mail-Followers-counter:contains(1)");
    expect(mailRequests).toInclude("/mail/thread/unsubscribe");
    await contains(".o-mail-Followers-button").click();
    await contains(`${menu} .o-mail-FollowerList-followBtn`).click();
    await waitFor(".o-mail-Followers-counter:contains(2)");
    expect(mailRequests).toInclude("/mail/thread/subscribe");
    await contains(".o-mail-Followers-button").click();
    await contains(`${menu} .o-dropdown-item:contains(Add Followers)`).click();
    await waitFor(".modal .o_form_view");
});

test("[Offline] lead chatter attachments, pinned messages, search and composer request nothing", async () => {
    const chatters = [];
    patchWithCleanup(Chatter.prototype, {
        setup() {
            super.setup(...arguments);
            chatters.push(this);
        },
    });
    /** The last lead chatter mounted (the displayed one). */
    const leadChatter = () =>
        chatters.findLast((chatter) => chatter.state.thread?.model === "crm.lead");
    const pyEnv = await startServer();
    pyEnv["mail.message"].create({
        author_id: serverState.partnerId,
        body: "Kick-off call done",
        message_type: "comment",
        model: "crm.lead",
        pinned_at: "2024-01-01 10:00:00",
        res_id: 1,
    });
    const attachmentId = pyEnv["ir.attachment"].create({
        mimetype: "text/plain",
        name: "brief.txt",
        res_id: 1,
        res_model: "crm.lead",
    });
    /** The lead's attachments on the server, by name. */
    const serverAttachments = () =>
        pyEnv["ir.attachment"]
            .search_read([
                ["res_model", "=", "crm.lead"],
                ["res_id", "=", 1],
            ])
            .map(({ name }) => name);
    const file = new File(["offline"], "offline.txt", { type: "text/plain" });
    const fileData = { data: btoa("offline"), name: "offline.txt", type: "text/plain" };
    const setOffline = mockOffline();
    const mailRequests = trackMailRequests();
    const stepping = stepRoutes();
    stepping.active = false;
    await start();
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    await openLead(1);
    await waitFor(".o-mail-Message:contains(Kick-off call done)");
    await waitFor("button[title='Pinned Messages']");
    const chatter = leadChatter();
    const thread = chatter.state.thread;
    expect(thread.id).toBe(1);
    const [attachment] = chatter.attachments;
    expect(attachment.id).toBe(attachmentId);

    // Online, the search panel is opened and a search shows its result in place of
    // the thread; a file dragged over the chatter shows its dropzone.
    await contains("button[title='Search Messages']").click();
    await contains(".o-mail-SearchInput input").edit("Kick", { confirm: false });
    await waitFor(".o-mail-SearchMessageResult .o-mail-Message:contains(Kick-off call done)");
    await dragenterFiles(".o-mail-Chatter", [file]);
    await waitFor(".o-Dropzone");
    await settle();
    mailRequests.length = 0;

    // The connection drops: the search panel and its result close, the thread shows
    // again, and the dropzone is gone. Forced open again, the panel closes again.
    await setOffline(true);
    await settle();
    stepping.active = true;
    expect(".o-mail-SearchMessageInput").toHaveCount(0);
    expect(".o-mail-SearchMessageResult").toHaveCount(0);
    expect(".o-mail-Message:contains(Kick-off call done)").toHaveCount(1);
    expect(".o-Dropzone").toHaveCount(0);
    expect(chatter.state.activePanel).toBe(chatter.CHATTER_PANEL.NONE);
    forceClick("button[title='Search Messages']");
    await settle();
    expect(".o-mail-SearchMessageInput").toHaveCount(0);
    expect(chatter.state.activePanel).toBe(chatter.CHATTER_PANEL.NONE);

    // Offline, a search run, its fetch and its message fetch called directly search
    // nothing; the pinned messages, called by a forced click or directly, do not open
    // and fetch nothing; neither the attachment removal, the composer openings, the
    // file chooser, the uploaded-file handler nor the uploader itself does anything;
    // a file dragged and dropped on the chatter gets no dropzone and uploads nothing.
    chatter.messageSearch.searchTerm = "Kick";
    await chatter.messageSearch.run();
    await chatter.messageSearch.fetch("Kick");
    await chatter.messageSearch.fetchMessages("Kick");
    expect(chatter.messageSearch.searching).toBe(false);
    chatter.messageSearch.reset();
    forceClick("button[title='Pinned Messages']");
    chatter.onClickPinnedMessages();
    await chatter.unlinkAttachment(attachment);
    await chatter.attachmentUploader.unlink(attachment);
    chatter.toggleComposer("message");
    chatter.toggleComposer("note");
    chatter.toggleComposer("note", { force: true });
    expect(await chatter.onClickAttachFile()).toBe(false);
    await chatter.onUploaded({ thread })(fileData);
    await chatter.attachmentUploader.uploadFile(file);
    await chatter.attachmentUploader.uploadData(fileData);
    await dragenterFiles(".o-mail-Chatter", [file]);
    expect(".o-Dropzone").toHaveCount(0);
    await dropFiles(".o-mail-Chatter", [file]);
    // A closing call of the composer keeps working.
    chatter.toggleComposer();
    await settle();
    expect(".o-mail-pinnedMessages").toHaveCount(0);
    expect(".o-mail-SearchMessageResult").toHaveCount(0);
    expect(".o-mail-Composer").toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect(chatter.state.activePanel).toBe(chatter.CHATTER_PANEL.NONE);
    expect(chatter.state.composerType).toBe(false);
    expect(chatter.attachments.map(({ id }) => id)).toEqual([attachmentId]);
    expect(serverAttachments()).toEqual(["brief.txt"]);
    expect(mailRequests).toEqual([]);
    expect.verifySteps([]);
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);
    stepping.active = false;

    // Online, the pinned messages open and are fetched. Their jump links are not
    // buttons: when the connection drops, the panel closes.
    await setOffline(false);
    await settle();
    await contains("button[title='Pinned Messages']").click();
    await waitFor(".o-mail-pinnedMessages .o-mail-Message:contains(Kick-off call done)");
    expect(mailRequests).toInclude("/mail/store");
    expect(".o-mail-pinnedMessages .o-mail-MessageCard-jump").toHaveCount(1);
    await setOffline(true);
    await settle();
    expect(".o-mail-pinnedMessages").toHaveCount(0);
    expect(chatter.state.activePanel).toBe(chatter.CHATTER_PANEL.NONE);
    await setOffline(false);
    await settle();

    // Online, a search fetches its result, the composer opens, a dropped file is
    // uploaded and the attachment is removed.
    mailRequests.length = 0;
    await contains("button[title='Search Messages']").click();
    await contains(".o-mail-SearchInput input").edit("Kick", { confirm: false });
    await waitFor(".o-mail-SearchMessageResult .o-mail-Message:contains(Kick-off call done)");
    // The thread search goes through the store.
    expect(mailRequests).toInclude("/mail/store");
    await contains(".o-mail-SearchMessageInput button[aria-label='Close button']").click();
    expect(".o-mail-SearchMessageInput").toHaveCount(0);
    chatter.toggleComposer("note");
    await waitFor(".o-mail-Composer");
    chatter.toggleComposer("note");
    await settle();
    expect(".o-mail-Composer").toHaveCount(0);
    expect(await chatter.onClickAttachFile()).toBe(undefined);
    await dragenterFiles(".o-mail-Chatter", [file]);
    await dropFiles(".o-Dropzone", [file]);
    await waitFor(".o-mail-AttachmentContainer:not(.o-isUploading):contains(offline.txt)");
    expect(mailRequests).toInclude("/mail/attachment/upload");
    await chatter.unlinkAttachment(attachment);
    await waitUntil(() => !serverAttachments().includes("brief.txt"));
    expect(mailRequests).toInclude("/mail/attachment/delete");
    expect(serverAttachments()).toEqual(["offline.txt"]);

    // A new lead, named online, with a file dragged over its chatter (its dropzone
    // shows): offline, the dropzone is gone, and its file chooser, composer openings
    // (and a closing call) and a dropped file neither save it (no queued create to
    // get a thread) nor request anything.
    await goBack();
    await getService("action").switchView("form");
    await animationFrame();
    await contains(".o_field_widget[name=name] input").edit("Unsaved lead");
    await waitFor(".o-mail-Chatter-sendMessage:enabled");
    const newLeadChatter = leadChatter();
    expect(newLeadChatter.state.thread.id).toBe(false);
    await dragenterFiles(".o-mail-Chatter", [file]);
    await waitFor(".o-Dropzone");
    await settle();
    mailRequests.length = 0;
    await setOffline(true);
    await settle();
    stepping.active = true;
    expect(".o-Dropzone").toHaveCount(0);
    expect(await newLeadChatter.onClickAttachFile()).toBe(false);
    newLeadChatter.toggleComposer("message");
    newLeadChatter.toggleComposer("note");
    newLeadChatter.toggleComposer();
    await dragenterFiles(".o-mail-Chatter", [file]);
    expect(".o-Dropzone").toHaveCount(0);
    await dropFiles(".o-mail-Chatter", [file]);
    await settle();
    expect(".o-mail-Composer").toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect(mailRequests).toEqual([]);
    expect.verifySteps([]);
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);
    expect(newLeadChatter.state.thread.id).toBe(false);
    expect(".o_field_widget[name=name] input").toHaveValue("Unsaved lead");
});

test("[Offline] same-record lead form reload fetches no thread, refetched online", async () => {
    // Offline root reloads served from the cache: after the wizard closes, and after
    // the systray discard.
    expect.errors(2);
    const pyEnv = await startServer();
    pyEnv["mail.message"].create({
        author_id: serverState.partnerId,
        body: "Kick-off call done",
        message_type: "comment",
        model: "crm.lead",
        res_id: 1,
    });
    const setOffline = mockOffline();
    const mailRequests = trackMailRequests();
    await start();
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    await openLead(1);
    await waitFor(".o-mail-Message:contains(Kick-off call done)");
    const thread = getService("mail.store")["mail.thread"].get({ model: "crm.lead", id: 1 });
    expect(thread.isLoaded).toBe(true);
    // The Mark Lost wizard is opened online from the form (from its "More" menu on
    // the mobile preset).
    const lostButton = `button[name='${LOST_ACTION_ID}']`;
    await revealFormControl(lostButton);
    await contains(lostButton).click();
    await waitFor(".modal .o_form_view");
    const threadFetches = trackLeadThreadFetches();
    mailRequests.length = 0;

    // Offline, closing the wizard and discarding a queued save from the systray each
    // reload the open lead (mail's MAIL:RELOAD-THREAD): its chatter requests nothing
    // and its thread is left without a loading error.
    await setOffline(true);
    pyEnv["mail.message"].create({
        author_id: serverState.partnerId,
        body: "Posted from another device",
        message_type: "comment",
        model: "crm.lead",
        res_id: 1,
    });
    await contains(".modal button[aria-label=Close]:visible").click();
    await settle();
    expect(".modal").toHaveCount(0);
    await contains(".o_field_widget[name=contact_name] input").edit("Offline contact");
    await contains(".o_form_button_save").click();
    expect(queued("crm.lead")).toHaveLength(1);
    await discardFromSystray("Lead 1");
    await settle();
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_field_widget[name=contact_name] input").toHaveValue("");
    expect.verifyErrors([LEAD_RECORD_LOAD, LEAD_RECORD_LOAD]);
    expect(mailRequests).toEqual([]);
    expect(thread.hasLoadingFailed).toBe(false);
    expect(".o-mail-Thread-error").toHaveCount(0);
    expect(".o-mail-Message:contains(Kick-off call done)").toHaveCount(1);
    expect(".o-mail-Message:contains(Posted from another device)").toHaveCount(0);

    // Back online, the skipped reloads are run once: the thread data and the new
    // messages of the lead.
    await setOffline(false);
    await waitFor(".o-mail-Message:contains(Posted from another device)");
    await settle();
    expect(mailRequests).toEqual(["/mail/store"]);
    expect(threadFetches.sort()).toEqual(["/mail/thread/messages 1", "mail.thread 1"]);
    expect(thread.hasLoadingFailed).toBe(false);
    expect(".o-mail-Message:contains(Kick-off call done)").toHaveCount(1);
    for (const button of CHATTER_BUTTONS) {
        expect(button).toBeEnabled();
    }
});

test("[Offline] lead opened offline with an unloaded thread loads it on reconnection", async () => {
    // Offline root loads served from the cache: lead 2, then lead 1 through the pager.
    expect.errors(2);
    const pyEnv = await startServer();
    pyEnv["mail.message"].create([
        {
            author_id: serverState.partnerId,
            body: "Kick-off call done",
            message_type: "comment",
            model: "crm.lead",
            res_id: 1,
        },
        {
            author_id: serverState.partnerId,
            body: "Second lead note",
            message_type: "comment",
            model: "crm.lead",
            res_id: 2,
        },
    ]);
    pyEnv["mail.followers"].create({
        partner_id: serverState.partnerId,
        res_id: 1,
        res_model: "crm.lead",
    });
    const setOffline = mockOffline();
    const mailRequests = trackMailRequests();
    await start();
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    // Online visits cache the forms of leads 2 and 1.
    await getService("action").switchView("form", { resId: 2, resIds: [1, 2] });
    await waitFor(".o-mail-Message:contains(Second lead note)");
    await contains(".o_pager_previous").click();
    await waitFor(".o-mail-Message:contains(Kick-off call done)");
    await goBack();
    // As after a new page load, the store holds neither thread: only the forms are
    // cached.
    const store = getService("mail.store");
    for (const id of [1, 2]) {
        store["mail.thread"].get({ model: "crm.lead", id }).delete();
    }
    const threadFetches = trackLeadThreadFetches();
    mailRequests.length = 0;

    // Offline, each lead opens with a read-only chatter and a followers button with
    // neither an endless spinner nor a made-up count; nothing is requested.
    await setOffline(true);
    await getService("action").switchView("form", { resId: 2, resIds: [1, 2] });
    await settle();
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Lead 2");
    for (const leadName of ["Lead 2", "Lead 1"]) {
        if (leadName === "Lead 1") {
            await contains(".o_pager_previous").click();
            await settle();
            expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Lead 1");
        }
        expect(".o-mail-Followers-button").toHaveCount(1);
        expect(".o-mail-Followers-button .fa-spin").toHaveCount(0);
        expect(".o-mail-Followers-counter").toHaveCount(0);
        expect(".o-mail-Message").toHaveCount(0);
        for (const button of CHATTER_BUTTONS) {
            expect(button).not.toBeEnabled();
        }
    }
    await advanceTime(10000);
    expect(".o-mail-Followers-button .fa-spin").toHaveCount(0);
    expect(mailRequests).toEqual([]);
    expect.verifyErrors([LEAD_RECORD_LOAD, LEAD_RECORD_LOAD]);

    // Back online, the displayed lead's thread loads once, without reopening it: its
    // messages, its follower count and enabled controls. The lead left offline
    // through the pager is not loaded.
    await setOffline(false);
    await waitFor(".o-mail-Message:contains(Kick-off call done)");
    await waitFor(".o-mail-Followers-counter:contains(1)");
    await settle();
    expect(".o-mail-Followers-button .fa-spin").toHaveCount(0);
    for (const button of CHATTER_BUTTONS) {
        expect(button).toBeEnabled();
    }
    expect(mailRequests).toEqual(["/mail/store"]);
    expect(threadFetches.sort()).toEqual(["/mail/thread/messages 1", "mail.thread 1"]);
    expect(store["mail.thread"].get({ model: "crm.lead", id: 2 }).isLoaded).toBe(false);
});

test("[Offline] lead chatter scrolled to its older messages loads none", async () => {
    const pyEnv = await startServer();
    for (let index = 1; index <= 35; index++) {
        pyEnv["mail.message"].create({
            author_id: serverState.partnerId,
            body: `Call note ${index}`,
            message_type: "comment",
            model: "crm.lead",
            res_id: 1,
        });
    }
    const setOffline = mockOffline();
    const mailRequests = trackMailRequests();
    await start();
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    await openLead(1);
    // Online, the chatter loads the newest page of messages.
    await waitFor(".o-mail-Message:contains(Call note 35)");
    expect(".o-mail-Message").toHaveCount(30);
    const loadMore = ".o-mail-Thread button:contains(Load More)";
    expect(loadMore).toHaveCount(1);
    const thread = getService("mail.store")["mail.thread"].get({ model: "crm.lead", id: 1 });
    mailRequests.length = 0;

    // Offline, bringing "Load More" into view (which loads the older messages
    // online) requests nothing and leaves the thread without a loading error.
    await setOffline(true);
    queryFirst(loadMore).scrollIntoView();
    await settle();
    await animationFrame();
    expect(mailRequests).toEqual([]);
    expect(thread.hasLoadingFailed).toBe(false);
    expect(".o-mail-Thread-error").toHaveCount(0);
    expect(".o-mail-Message").toHaveCount(30);
    expect(loadMore).not.toBeEnabled();

    // Online, "Load More" loads them.
    await setOffline(false);
    await animationFrame();
    await contains(loadMore).click();
    await waitUntil(() => queryAll(".o-mail-Message").length === 35);
    expect(mailRequests).toEqual(["/mail/store"]);
    expect(thread.hasLoadingFailed).toBe(false);
});

// This test renders the chatters of a lead and of a partner, 35 messages each, and
// loads the lead's older messages. Under 3× CPU throttling on the mobile preset it
// lasts 3.6 to 5.5 s on an idle host, around Hoot's 5 s default timeout, and 4 to
// 12 s on a loaded one, beyond it (a timed-out test keeps running into the next
// tests). Its own timeout replaces the runner's, so it stays above the 15 s the suite
// runners pass.
test.timeout(30_000);
test("[Offline] lead chatter load-older handlers called directly fetch nothing", async () => {
    const threadComponents = [];
    patchWithCleanup(Thread.prototype, {
        setup() {
            super.setup(...arguments);
            threadComponents.push(this);
        },
    });
    const pyEnv = await startServer();
    const partnerId = pyEnv["res.partner"].create({ name: "Azure Interior" });
    for (let index = 1; index <= 35; index++) {
        pyEnv["mail.message"].create([
            {
                author_id: serverState.partnerId,
                body: `Call note ${index}`,
                message_type: "comment",
                model: "crm.lead",
                res_id: 1,
            },
            {
                author_id: serverState.partnerId,
                body: `Partner note ${index}`,
                message_type: "comment",
                model: "res.partner",
                res_id: partnerId,
            },
        ]);
    }
    const setOffline = mockOffline();
    const mailRequests = trackMailRequests();
    await start();
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    await openLead(1);
    // Online, the chatter loads the newest page of messages.
    await waitFor(".o-mail-Message:contains(Call note 35)");
    expect(".o-mail-Message").toHaveCount(30);
    const loadMore = ".o-mail-Thread button:contains(Load More)";
    expect(loadMore).toHaveCount(1);
    const store = getService("mail.store");
    const thread = store["mail.thread"].get({ model: "crm.lead", id: 1 });
    const leadThread = threadComponents.find(
        (component) => component.env.inChatter && component.props.thread.eq(thread)
    );
    expect(Boolean(leadThread)).toBe(true);
    mailRequests.length = 0;

    // Offline, the handlers that load messages, called directly, request nothing and
    // leave the thread without a loading error: load older, retry, a jump to the
    // present (which reloads the newest page), and an immediate jump while newer
    // messages are left to load.
    await setOffline(true);
    await leadThread.onClickLoadOlder();
    leadThread.onClickRetry();
    await leadThread.jumpToPresent();
    thread.loadNewer = true;
    await leadThread.jumpToPresent({ immediate: true });
    expect(thread.loadNewer).toBe(true);
    thread.loadNewer = false;
    // An immediate jump with nothing newer to load only scrolls, as online.
    await leadThread.jumpToPresent({ immediate: true });
    await settle();
    expect(mailRequests).toEqual([]);
    expect(thread.hasLoadingFailed).toBe(false);
    expect(".o-mail-Thread-error").toHaveCount(0);
    expect(".o-mail-Message").toHaveCount(30);
    expect(loadMore).toHaveCount(1);
    expect(loadMore).not.toBeEnabled();
    expect(Object.keys(getService(OfflinePlugin)._ormToSync())).toEqual([]);

    // Online, the same direct call loads the older messages.
    await setOffline(false);
    await animationFrame();
    await leadThread.onClickLoadOlder();
    await waitUntil(() => queryAll(".o-mail-Message").length === 35);
    expect(mailRequests).toEqual(["/mail/store"]);
    expect(thread.hasLoadingFailed).toBe(false);

    // Another model's chatter is untouched: offline, its load-older handler runs the
    // original code, which requests the older messages.
    await getService("action").doAction({
        type: "ir.actions.act_window",
        res_model: "res.partner",
        res_id: partnerId,
        views: [[false, "form"]],
    });
    await waitFor(".o-mail-Message:contains(Partner note 35)");
    const partnerThread = threadComponents.find(
        (component) =>
            component.env.inChatter &&
            component.props.thread.eq(
                store["mail.thread"].get({ model: "res.partner", id: partnerId })
            )
    );
    expect(Boolean(partnerThread)).toBe(true);
    mailRequests.length = 0;
    await setOffline(true);
    await partnerThread.onClickLoadOlder();
    await waitUntil(() => mailRequests.includes("/mail/store"));
});

/**
 * The followers wizard of the followers menu (`mail.followers.edit`) on its real
 * footer: its Add saves the wizard, then calls `edit_followers`.
 */
const LEAD_FOLLOWERS_WIZARD_ARCH = /* xml */ `
    <form>
        <field name="res_model"/>
        <footer>
            <button name="edit_followers" type="object" string="Add Followers" class="btn-primary"/>
            <button special="cancel" string="Discard"/>
        </footer>
    </form>`;

/**
 * The full composer on the real composer view (`js_class="mail_composer_form"`), with
 * the recipient fields mail reads back to the thread when its dialog is closed.
 */
const LEAD_FULL_COMPOSER_ARCH = /* xml */ `
    <form js_class="mail_composer_form">
        <field name="subtype_is_log" invisible="1"/>
        <field name="partner_ids" invisible="1"/>
        <field name="partner_cc_ids" invisible="1"/>
        <field name="subject"/>
        <footer>
            <button name="action_send_mail" type="object" string="Send" class="btn-primary" data-hotkey="q"/>
            <button special="cancel" string="Discard"/>
        </footer>
    </form>`;

test("[Offline] lead chatter wizards opened online save, send and queue nothing", async () => {
    // The Send of another model's composer, attempted offline once the framework has
    // queued its save.
    expect.errors(1);
    const composers = [];
    patchWithCleanup(Composer.prototype, {
        setup() {
            super.setup(...arguments);
            composers.push(this);
        },
    });
    const controllers = captureFormControllers();
    registerInlineViewArchs("mail.followers.edit", { "form,false": LEAD_FOLLOWERS_WIZARD_ARCH });
    registerInlineViewArchs("mail.compose.message", { "form,false": LEAD_FULL_COMPOSER_ARCH });
    await startServer();
    onRpc("mail.followers.edit", "edit_followers", ({ args }) =>
        stepServerCall("edit_followers", args[0])
    );
    onRpc("mail.compose.message", "action_send_mail", ({ args }) =>
        stepServerCall("action_send_mail", args[0])
    );
    const setOffline = mockOffline();
    const mailRequests = trackMailRequests();
    stepRoutes(
        (route) => route.startsWith("/web/dataset/call_button/") || route.endsWith("/web_save")
    );
    await start();
    await getService("action").doAction(LEADS_ACTION.id);
    await flushStartupSync();
    await openLead(1);
    await waitFor(".o-mail-Chatter .o-mail-Followers-button");
    const wizardController = (model) =>
        controllers.findLast((form) => form.props.resModel === model);
    const menu = ".o-mail-Followers-dropdown";
    const add = ".modal footer button[name=edit_followers]";
    const send = ".modal footer button[name=action_send_mail]";
    const subject = ".modal .o_field_widget[name=subject] input";
    const close = ".modal button[aria-label=Close]:visible";

    /**
     * Opens the followers wizard from the lead's followers menu. The followers button
     * stays disabled until the thread's access rights are loaded, and a click on it
     * before then is dropped, so the click waits for the enabled button.
     */
    const openFollowersWizard = async () => {
        await contains(".o-mail-Followers-button:enabled").click();
        await contains(`${menu} .o-dropdown-item:contains(Add Followers)`).click();
        await waitFor(".modal .o_form_view");
        return wizardController("mail.followers.edit");
    };
    /** Opens the full composer from the lead chatter's composer. */
    const openFullComposer = async () => {
        await contains(".o-mail-Chatter-sendMessage").click();
        await waitFor(".o-mail-Composer");
        const composer = composers.findLast(
            (candidate) => candidate.props.composer?.thread?.model === "crm.lead"
        );
        await composer.onClickFullComposer();
        await waitFor(".modal .o_form_view");
        return wizardController("mail.compose.message");
    };

    // The followers wizard, opened online on the lead.
    const followersWizard = await openFollowersWizard();
    expect(followersWizard.props.context.default_res_model).toBe("crm.lead");
    await settle();
    expect.verifySteps([]);

    // Offline, its Add, forced or run through the controller, and a direct save of its
    // record request, queue and change nothing; the wizard stays open, and its close
    // control closes it.
    await setOffline(true);
    await settle();
    expect(add).not.toBeEnabled();
    forceClick(add);
    await settle();
    expect(
        await followersWizard.beforeExecuteActionButton({ name: "edit_followers", type: "object" })
    ).toBe(false);
    expect(await followersWizard.model.root.save()).toBe(false);
    await settle();
    expect(".modal .o_form_view").toHaveCount(1);
    expect(followersWizard.model.root.isNew).toBe(true);
    expect(queued("mail.followers.edit")).toEqual([]);
    expect.verifySteps([]);
    await contains(close).click();
    expect(".modal").toHaveCount(0);

    // Back online, nothing is replayed, and the wizard adds followers again.
    await reconnect(setOffline);
    expect(queued("mail.followers.edit")).toEqual([]);
    expect.verifySteps([]);
    await openFollowersWizard();
    const followersWizardId = MockServer.env["mail.followers.edit"].search([]).length + 1;
    await contains(add).click();
    await expect.waitForSteps([
        "/web/dataset/call_kw/mail.followers.edit/web_save",
        buttonRoute("mail.followers.edit", "edit_followers"),
        `edit_followers [${followersWizardId}]`,
    ]);
    expect(".modal").toHaveCount(0);

    // The full composer, opened online from the lead chatter's composer.
    const fullComposer = await openFullComposer();
    expect(fullComposer).toBeInstanceOf(MailComposerFormController);
    expect(fullComposer.props.context.default_model).toBe("crm.lead");
    await contains(subject).edit("Proposal", { confirm: "blur" });
    await settle();
    expect.verifySteps([]);

    // Offline, the chatter's composer closes and the full composer stays: its Send,
    // forced or run through the controller, and a direct save of its record request,
    // queue and send nothing, and it keeps what was entered.
    await setOffline(true);
    await settle();
    expect(".o-mail-Composer").toHaveCount(0);
    expect(send).not.toBeEnabled();
    forceClick(send);
    await settle();
    expect(
        await fullComposer.beforeExecuteActionButton({ name: "action_send_mail", type: "object" })
    ).toBe(false);
    expect(await fullComposer.model.root.save()).toBe(false);
    await settle();
    expect(".modal .o_form_view").toHaveCount(1);
    expect(subject).toHaveValue("Proposal");
    expect(fullComposer.model.root.isNew).toBe(true);
    expect(queued("mail.compose.message")).toEqual([]);
    expect.verifySteps([]);
    // Its close control closes it with no request (mail's recipient read is skipped).
    mailRequests.length = 0;
    await contains(close).click();
    await settle();
    expect(".modal").toHaveCount(0);
    expect(mailRequests).toEqual([]);
    expect.verifySteps([]);

    // Back online, nothing is replayed, and the full composer opens with its Send
    // enabled again.
    await reconnect(setOffline);
    expect(queued("mail.compose.message")).toEqual([]);
    expect.verifySteps([]);
    await openFullComposer();
    expect(send).toBeEnabled();
    await cancelDialog();
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);

    // A composer of another model's chatter keeps mail's offline behaviour: a forced
    // Send has the framework queue its save, then attempts the button's call, and the
    // save replays once online.
    await getService("action").doAction({
        type: "ir.actions.act_window",
        name: "Compose Email",
        res_model: "mail.compose.message",
        target: "new",
        views: [[false, "form"]],
        context: { default_model: "res.partner" },
    });
    await waitFor(".modal .o_form_view");
    await contains(subject).edit("Hello", { confirm: "blur" });
    await setOffline(true);
    await settle();
    forceClick(send);
    await settle();
    expect.verifySteps([
        "/web/dataset/call_kw/mail.compose.message/web_save",
        buttonRoute("mail.compose.message", "action_send_mail"),
    ]);
    expect.verifyErrors([buttonRoute("mail.compose.message", "action_send_mail")]);
    expect(queuedCalls("mail.compose.message").map(({ method }) => method)).toEqual(["web_save"]);
    await reconnect(setOffline);
    expect.verifySteps(["/web/dataset/call_kw/mail.compose.message/web_save"]);
    expect(queued("mail.compose.message")).toEqual([]);
    await cancelDialog();
    expect(".modal").toHaveCount(0);
});

/**
 * Selector of a lead card of the pipeline: a kanban card on desktop; on the mobile
 * pipeline, the card in the stage that displays it (a card shows its queued stage),
 * browsed from the first stage.
 *
 * @param {string} leadName
 */
async function revealLeadCard(leadName) {
    if (!isSmall()) {
        return `.o_kanban_record:contains(${leadName})`;
    }
    const card = `.o_crm_mobile_lead_card:has(.o_crm_mobile_lead_name:contains(${leadName}))`;
    while (!queryAll(card).length && queryFirst(".o_crm_mobile_pipeline_prev:enabled")) {
        await contains(".o_crm_mobile_pipeline_prev").click();
    }
    while (!queryAll(card).length && queryFirst(".o_crm_mobile_pipeline_next:enabled")) {
        await contains(".o_crm_mobile_pipeline_next").click();
    }
    return card;
}

/**
 * Moves a lead card to a stage: drag and drop into the stage column on desktop, the
 * card's stage selector on the mobile pipeline.
 *
 * @param {string} leadName
 * @param {number} stageId
 * @param {number} columnIndex index of the stage column (desktop)
 */
async function moveLeadCard(leadName, stageId, columnIndex) {
    const card = await revealLeadCard(leadName);
    if (isSmall()) {
        await contains(`${card} select.o_crm_mobile_lead_stage`).select(`${stageId}`);
    } else {
        await contains(card).dragAndDrop(`.o_kanban_group:eq(${columnIndex})`);
    }
    await animationFrame();
}

test("[Offline] two distinct writes to one lead replay in order, last write wins", async () => {
    // Offline root load served from the cache: the pipeline groups (back from the form).
    expect.errors(1);
    onRpc("crm.lead", "web_save", ({ args }) => {
        expect.step(`web_save ${JSON.stringify(args[0])} stage ${args[1].stage_id}`);
    });
    // The clock is set before the views and the cache are created. The start-up timers
    // then move it on by their longest pending delay, which varies from run to run, so
    // T2 is set from the queued T1 rather than at a fixed time.
    mockDate("2026-10-02 09:00:00");
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    await openLead(1);
    await setOffline(true);

    // T1: the lead form saves stage B (Qualified) through its own Record.
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_form_button_save").click();
    await goBack();
    expect.verifyErrors([LEAD_GROUPS_LOAD]);
    // T2 = T1 + 5 min: the pipeline card (another Record of the same lead) moves it to C (Won).
    const [formSave] = queued("crm.lead");
    mockDate(new Date(formSave.value.extras.timeStamp + 5 * 60_000).toISOString());
    await moveLeadCard("Lead 1", STAGE_WON, 2);

    // Two queue entries with distinct keys, in timestamp order.
    const entries = queued("crm.lead");
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_QUALIFIED }],
            kwargs: { context: queuedContext(PIPELINE_ACTION.context), specification: {} },
        },
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_WON }],
            kwargs: {
                context: queuedContext(PIPELINE_ACTION.context, { default_stage_id: STAGE_NEW }),
                specification: {},
            },
        },
    ]);
    expect(entries[0].key).not.toBe(entries[1].key);
    expect(entries[0].value.extras.timeStamp).toBeLessThan(entries[1].value.extras.timeStamp);
    expect.verifySteps([]);

    // Replay in timestamp order: the last write wins.
    await reconnect(setOffline);
    await runAllTimers();
    await expect.waitForSteps([
        `web_save [1] stage ${STAGE_QUALIFIED}`,
        `web_save [1] stage ${STAGE_WON}`,
    ]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_WON);
    expect(".modal").toHaveCount(0);
});

test("[Offline] online save during the replay of the lead's queued save is sent after it", async () => {
    // The server holds the replay of another lead's write until it is released, so the
    // replay is still running, with the lead's queued save still to be sent, when the
    // form saves again online.
    const otherReplay = Promise.withResolvers();
    onRpc("crm.lead", "web_save", async ({ args }) => {
        expect.step(`web_save ${JSON.stringify(args[0])} ${JSON.stringify(args[1])}`);
        if (args[0][0] === 2) {
            await otherReplay.promise;
        }
    });
    // The clock is set before the views and the cache are created (see the test above).
    mockDate("2026-10-02 09:00:00");
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    await openLead(1);
    const plugin = getService(OfflinePlugin);

    // Offline: a write of another lead is queued, then the form saves 1800 a minute
    // later and stays open.
    await setOffline(true);
    const otherKey = queueLeadRename(plugin, 2, "Lead 2 renamed");
    const otherTimeStamp = plugin._ormToSync()[otherKey].value.extras.timeStamp;
    mockDate(new Date(otherTimeStamp + 60_000).toISOString());
    await contains(".o_field_widget[name=expected_revenue] input").edit("1800");
    await contains(".o_form_button_save").click();
    const formSave = queued("crm.lead").find(({ key }) => key !== otherKey);
    expect(formSave.value.args).toEqual([[1], { expected_revenue: 1800 }]);
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([otherKey, formSave.key]);
    expect.verifySteps([]);

    // Reconnected: the replay sends the other lead's write first, and is held there.
    await setOffline(false);
    await expect.waitForSteps([`web_save [2] ${JSON.stringify({ name: "Lead 2 renamed" })}`]);
    expect(plugin.syncingORM()).toBe(true);
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([otherKey, formSave.key]);

    // The user's later write, saved online meanwhile, is not sent ahead of the lead's
    // queued save: the save waits, with the form's Save button disabled.
    await contains(".o_field_widget[name=expected_revenue] input").edit("1801");
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect.verifySteps([]);
    expect(".o_form_button_save").not.toBeEnabled();

    // The lead's queued save replays one second later, then the online save is sent:
    // the user's last write wins.
    otherReplay.resolve();
    await waitUntil(() => !(otherKey in plugin._ormToSync()));
    await runAllTimers();
    await expect.waitForSteps([
        `web_save [1] ${JSON.stringify({ expected_revenue: 1800 })}`,
        `web_save [1] ${JSON.stringify({ expected_revenue: 1801 })}`,
    ]);
    await runAllTimers();
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].expected_revenue).toBe(1801);
    expect(MockServer.env["crm.lead"].browse(2)[0].name).toBe("Lead 2 renamed");
    expect(".o_field_widget[name=expected_revenue] input").toHaveValue("1,801.00");
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

// Refine D1.1 (R1): once the connection is back, the framework reports it lost until
// a request reaches the server. A lead save made meanwhile must not reach the server
// ahead of the lead's older queued writes, whose replay would then overwrite it.

/**
 * A connection that comes back before the framework notices it: while `down`, every
 * request is refused; restoring it leaves the framework's connection state as it is
 * until its next request or connection check.
 *
 * @returns {{down: boolean}}
 */
function mockNetwork() {
    const network = { down: false };
    onRpc("/*", () => {
        if (network.down) {
            return new Response("", { status: 502 });
        }
    });
    return network;
}

/**
 * Loses the connection: the network is down and the framework reports it lost.
 *
 * @param {{down: boolean}} network `mockNetwork()`
 */
async function loseConnection(network) {
    network.down = true;
    getService(OfflinePlugin).setOffline(true);
    await animationFrame();
}

test("[Offline] lead save made before the connection is seen back replays with its queued save", async () => {
    stepLeadWrites();
    const network = mockNetwork();
    await openPipeline();
    await flushStartupSync();
    await openLead(1);
    const plugin = getService(OfflinePlugin);

    // T1, offline: the form saves a name and a revenue, queued.
    await loseConnection(network);
    await contains(".o_field_widget[name=name] input").edit("Lead 1 renamed");
    await contains(".o_field_widget[name=expected_revenue] input").edit("1800");
    await contains(".o_form_button_save").click();
    const [formSave] = queued("crm.lead");
    expect(formSave.value.args).toEqual([[1], { name: "Lead 1 renamed", expected_revenue: 1800 }]);

    // T2: the connection is back, while the framework still reports it lost, when the
    // form saves another revenue. The save is not sent ahead of the queued one, whose
    // replay would overwrite it: it is queued with it, as an offline save is, and the
    // connection check it starts finds the connection back, so the replay sends the
    // queued save with the user's last values, once.
    network.down = false;
    await contains(".o_field_widget[name=expected_revenue] input").edit("1801");
    expect(plugin.isOffline()).toBe(true);
    await contains(".o_form_button_save").click();
    await expect.waitForSteps([
        `web_save [1] ${JSON.stringify({ name: "Lead 1 renamed", expected_revenue: 1801 })}`,
    ]);
    await runAllTimers();
    await animationFrame();
    expect(plugin.isOffline()).toBe(false);
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0]).toMatchObject({
        name: "Lead 1 renamed",
        expected_revenue: 1801,
    });
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 renamed");
    expect(".o_field_widget[name=expected_revenue] input").toHaveValue("1,801.00");
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

test("[Offline] lead form save made before the connection is seen back replays after a queued card move", async () => {
    // Offline root load served from the cache: the lead form opened after the move.
    expect.errors(1);
    stepLeadWrites();
    const network = mockNetwork();
    await openPipeline();
    await flushStartupSync();
    // Visited online, so that its form is available offline.
    await openLead(1);
    await goBack();

    // T1, offline: the pipeline card (another Record of the lead) moves it to Won.
    await loseConnection(network);
    await moveLeadCard("Lead 1", STAGE_WON, 2);
    const [cardMove] = queued("crm.lead");
    expect(cardMove.value.args).toEqual([[1], { stage_id: STAGE_WON }]);

    // T2: the lead form, opened from the cache, shows the queued stage. The connection
    // is back, while the framework still reports it lost, when the form saves stage
    // Qualified: the save is queued after the card move instead of being sent ahead
    // of it, and the replay that the save's connection check starts sends the card
    // move first, the user's last stage last.
    await openLead(1);
    expect(currentStageSelector()).toHaveText("Won");
    network.down = false;
    await selectStage(STAGE_QUALIFIED, "Qualified");
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    await contains(".o_form_button_save").click();
    await expect.waitForSteps([`web_save [1] ${JSON.stringify({ stage_id: STAGE_WON })}`]);
    await runAllTimers();
    await expect.waitForSteps([`web_save [1] ${JSON.stringify({ stage_id: STAGE_QUALIFIED })}`]);
    await runAllTimers();
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_QUALIFIED);
    expect(currentStageSelector()).toHaveText("Qualified");
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
    expect.verifyErrors([LEAD_RECORD_LOAD]);
});

/**
 * Runs the replays of the page one after another, as the browser's cross-tab replay
 * lock does, which Hoot's lock manager mock grants to every request at once: a
 * replay the framework starts while another one runs (whenever the connection is
 * seen back) starts once that one has ended, and reads the queue then.
 *
 * @param {OfflinePlugin} plugin
 */
function serializeReplays(plugin) {
    const syncORM = plugin._syncORM;
    let previous = Promise.resolve();
    patchWithCleanup(plugin, {
        _syncORM() {
            const run = previous.then(() => {
                // A replay runs from the moment it sets `syncingORM` (at once, as the
                // mock lock runs it synchronously) until it unsets it.
                let stop;
                const ended = new Promise((resolve) => {
                    let started = false;
                    stop = untrack(() =>
                        effect(() => {
                            if (plugin.syncingORM()) {
                                started = true;
                            } else if (started) {
                                resolve();
                            }
                        })
                    );
                });
                syncORM.call(plugin);
                return ended.then(() => stop());
            });
            previous = run;
            return run;
        },
    });
}

/**
 * Sets up a replay held on the server: offline, a write of lead 2 is queued, then
 * the form of lead 1 (open) saves a revenue of 1800 a minute later; once reconnected,
 * the replay sends lead 2's write first, and the server holds it until `release` is
 * resolved, so the replay is still running with lead 1's queued save still to be sent.
 * Replays run one after another (`serializeReplays`).
 *
 * @returns {Promise<{plugin: OfflinePlugin, network: {down: boolean}, release: () => void, otherKey: string, formSave: Object}>}
 */
async function holdReplayBeforeLeadSave() {
    const otherReplay = Promise.withResolvers();
    onRpc("crm.lead", "web_save", async ({ args }) => {
        expect.step(`web_save ${JSON.stringify(args[0])} ${JSON.stringify(args[1])}`);
        if (args[0][0] === 2) {
            await otherReplay.promise;
        }
    });
    const network = mockNetwork();
    // The clock is set before the views and the cache are created (see above).
    mockDate("2026-10-02 09:00:00");
    await openPipeline();
    await flushStartupSync();
    await openLead(1);
    const plugin = getService(OfflinePlugin);
    serializeReplays(plugin);

    await loseConnection(network);
    const otherKey = queueLeadRename(plugin, 2, "Lead 2 renamed");
    const otherTimeStamp = plugin._ormToSync()[otherKey].value.extras.timeStamp;
    mockDate(new Date(otherTimeStamp + 60_000).toISOString());
    await contains(".o_field_widget[name=expected_revenue] input").edit("1800");
    await contains(".o_form_button_save").click();
    const formSave = queued("crm.lead").find(({ key }) => key !== otherKey);
    expect(formSave.value.args).toEqual([[1], { expected_revenue: 1800 }]);
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([otherKey, formSave.key]);

    network.down = false;
    plugin.setOffline(false);
    await expect.waitForSteps([`web_save [2] ${JSON.stringify({ name: "Lead 2 renamed" })}`]);
    expect(plugin.syncingORM()).toBe(true);
    return { plugin, network, release: otherReplay.resolve, otherKey, formSave };
}

test("[Offline] save held during a replay stays held when a lost connection is reported", async () => {
    const { plugin, release, otherKey } = await holdReplayBeforeLeadSave();

    // The user's later write, saved during the replay, waits for the lead's queued save.
    await contains(".o_field_widget[name=expected_revenue] input").edit("1801");
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect.verifySteps([]);

    // A request fails meanwhile: the framework reports the connection lost while it
    // is in fact up. The save is not sent ahead of the lead's queued save, which the
    // running replay still sends with its own value: it keeps waiting.
    plugin.setOffline(true);
    await animationFrame();
    expect.verifySteps([]);
    expect(".o_form_button_save").not.toBeEnabled();

    // The replay goes on, its calls reaching the server report the connection back,
    // it sends the lead's queued save, and then the user's write: it wins.
    release();
    await waitUntil(() => !(otherKey in plugin._ormToSync()));
    await runAllTimers();
    await expect.waitForSteps([
        `web_save [1] ${JSON.stringify({ expected_revenue: 1800 })}`,
        `web_save [1] ${JSON.stringify({ expected_revenue: 1801 })}`,
    ]);
    await runAllTimers();
    await animationFrame();
    expect(plugin.isOffline()).toBe(false);
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].expected_revenue).toBe(1801);
    expect(".o_field_widget[name=expected_revenue] input").toHaveValue("1,801.00");
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

// Refine D1.1 (R1): the two save paths of the replay hold that no test exercised, a
// page-close save during a replay and a held save whose connection drops.

test("[Offline] page-close save during a replay is sent at once by beacon, not held", async () => {
    // The beacon reaches the server as it is sent (the page may be gone afterwards).
    const beacons = [];
    mockSendBeacon((route, blob) => {
        expect.step(`sendBeacon ${route}`);
        beacons.push(
            blob.text().then((text) => {
                const { params } = JSON.parse(text);
                MockServer.env[params.model].write(params.args[0], params.args[1]);
                return params;
            })
        );
        return true;
    });
    const { plugin, release, otherKey, formSave } = await holdReplayBeforeLeadSave();

    // During the replay, with the lead's queued save still to be sent, the lead is
    // renamed and the page closed: the urgent save does not wait for the replay. Its
    // beacon is sent at once with the rename, and the page may be left.
    await contains(".o_field_widget[name=name] input").edit("Lead 1 renamed");
    const [event] = await unload();
    expect.verifySteps(["sendBeacon /web/dataset/call_kw/crm.lead/web_save"]);
    const [params] = await Promise.all(beacons);
    expect(params).toMatchObject({
        model: "crm.lead",
        method: "web_save",
        args: [[1], { name: "Lead 1 renamed" }],
        kwargs: { specification: {} },
    });
    expect(event.defaultPrevented).toBe(false);
    expect(plugin.syncingORM()).toBe(true);
    expect(formSave.key in plugin._ormToSync()).toBe(true);
    await animationFrame();
    expect(".o_form_status_indicator_buttons:not(.invisible)").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);

    // The page stays: the replay goes on with the lead's queued save (the revenue),
    // and the server keeps the name the beacon wrote.
    release();
    await waitUntil(() => !(otherKey in plugin._ormToSync()));
    await runAllTimers();
    await expect.waitForSteps([`web_save [1] ${JSON.stringify({ expected_revenue: 1800 })}`]);
    await runAllTimers();
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0]).toMatchObject({
        name: "Lead 1 renamed",
        expected_revenue: 1800,
    });
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 renamed");
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

test("[Offline] save held during a replay whose connection drops ends queued with the lead's save", async () => {
    stepLeadWrites();
    const network = mockNetwork();
    // The clock is set before the views and the cache are created (see above).
    mockDate("2026-10-02 09:00:00");
    await openPipeline();
    await flushStartupSync();
    await openLead(1);
    const plugin = getService(OfflinePlugin);

    // Offline: a write of another lead is queued, then the form saves 1800 a minute later.
    await loseConnection(network);
    const otherKey = queueLeadRename(plugin, 2, "Lead 2 renamed");
    const otherTimeStamp = plugin._ormToSync()[otherKey].value.extras.timeStamp;
    mockDate(new Date(otherTimeStamp + 60_000).toISOString());
    await contains(".o_field_widget[name=expected_revenue] input").edit("1800");
    await contains(".o_form_button_save").click();
    const formSave = queued("crm.lead").find(({ key }) => key !== otherKey);
    expect(formSave.value.args).toEqual([[1], { expected_revenue: 1800 }]);

    // Reconnected: the replay sends the other lead's write, then waits a second before
    // the lead's queued save. The user's later write, saved meanwhile, waits for it.
    network.down = false;
    plugin.setOffline(false);
    await expect.waitForSteps([`web_save [2] ${JSON.stringify({ name: "Lead 2 renamed" })}`]);
    await waitUntil(() => !(otherKey in plugin._ormToSync()));
    await contains(".o_field_widget[name=expected_revenue] input").edit("1801");
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect(plugin.syncingORM()).toBe(true);
    expect(".o_form_button_save").not.toBeEnabled();
    expect.verifySteps([]);

    // The connection drops before the replay sends the lead's save. The replay stops
    // on that lost call, which releases the held save: it is queued without being
    // sent, merged into the lead's queued save, which now holds the user's value.
    await loseConnection(network);
    await runAllTimers();
    await waitUntil(() => !plugin.syncingORM());
    await waitUntil(() => queued("crm.lead")[0]?.value.args[1].expected_revenue === 1801);
    await animationFrame();
    expect(plugin.isOffline()).toBe(true);
    const [leadSave] = queued("crm.lead");
    expect(leadSave.key).toBe(formSave.key);
    expect(leadSave.value.extras.error).toBe(undefined);
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { expected_revenue: 1801 }],
            kwargs: { context: queuedContext(PIPELINE_ACTION.context), specification: {} },
        },
    ]);
    expect(".o_form_status_indicator_buttons:not(.invisible)").toHaveCount(0);
    expect(".o_field_widget[name=expected_revenue] input").toHaveValue("1,801.00");
    expect.verifySteps([]);

    // Back online, the replay sends the lead's save once, with the user's value.
    network.down = false;
    plugin.setOffline(false);
    await expect.waitForSteps([`web_save [1] ${JSON.stringify({ expected_revenue: 1801 })}`]);
    await runAllTimers();
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0]).toMatchObject({
        name: "Lead 1",
        expected_revenue: 1801,
    });
    expect(MockServer.env["crm.lead"].browse(2)[0].name).toBe("Lead 2 renamed");
    expect(".o_field_widget[name=expected_revenue] input").toHaveValue("1,801.00");
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

/**
 * Steps each `crm.lead` `web_save` reaching the mock server as `web_save <ids> <values>`
 * (`action_set_won` is stepped with its payload for every test).
 */
function stepLeadWrites() {
    onRpc("crm.lead", "web_save", ({ args }) => {
        expect.step(`web_save ${JSON.stringify(args[0])} ${JSON.stringify(args[1])}`);
    });
}

/** The `action_set_won` payload the lead form queues for lead 1 of "My Pipeline". */
function pipelineLeadWonCall() {
    return {
        model: "crm.lead",
        method: "action_set_won",
        args: [[1]],
        kwargs: { context: queuedContext(PIPELINE_ACTION.context) },
    };
}

test("[Offline] lead form saved again after a card move replays last, its last write wins", async () => {
    // Offline root loads served from the cache: the pipeline groups (back from the
    // form) and the reopened lead.
    expect.errors(2);
    stepLeadWrites();
    mockDate("2026-10-02 09:00:00");
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    await openLead(1);
    await setOffline(true);

    // T1: the lead form saves stage B (Qualified); T2 = T1 + 5 min: the pipeline card
    // (another Record of the lead) moves it to C (Won).
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_form_button_save").click();
    await goBack();
    const [formSave] = queued("crm.lead");
    mockDate(new Date(formSave.value.extras.timeStamp + 5 * 60_000).toISOString());
    await moveLeadCard("Lead 1", STAGE_WON, 2);
    const cardMove = queued("crm.lead").find(({ key }) => key !== formSave.key);
    expect(cardMove.value.args).toEqual([[1], { stage_id: STAGE_WON }]);

    // Reopened, the form shows the card's later stage: the stage restored from its
    // own (earlier) queued save is not an unsaved edit, and the queue is unchanged.
    await openLead(1);
    expect(currentStageSelector()).toHaveText("Won");
    expect(".o_form_status_indicator_buttons").toHaveClass("invisible");
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([formSave.key, cardMove.key]);

    // T3, the user's last write (stage A, New), on a clock held at T2: the form's queued
    // save now replays after the card move.
    await selectStage(STAGE_NEW, "New");
    await contains(".o_form_button_save").click();
    const entries = queued("crm.lead");
    expect(entries.map(({ key }) => key)).toEqual([cardMove.key, formSave.key]);
    expect(entries[1].value.args).toEqual([[1], { stage_id: STAGE_NEW }]);
    expect(entries[1].value.extras.timeStamp).toBeGreaterThan(cardMove.value.extras.timeStamp);
    expect.verifySteps([]);

    await reconnect(setOffline);
    await runAllTimers();
    await expect.waitForSteps([
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_WON })}`,
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_NEW })}`,
    ]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_NEW);
    await animationFrame();
    expect(currentStageSelector()).toHaveText("New");
    expect(".modal").toHaveCount(0);
    expect.verifyErrors([LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD]);
});

// Refine D1.3 (R3): an online write from a lead's pipeline card made while the
// replay has still to send a queued write of that lead (the lead's form save) is
// sent after it, so the card's value, written last, is the one the server keeps.

/**
 * Steps each `crm.lead` `web_save` reaching the mock server (as `stepLeadWrites`),
 * and holds the one of lead 2 until the returned deferred is resolved: replayed
 * first, it keeps the replay running with the queued writes of the other leads still
 * to be sent.
 *
 * @returns {PromiseWithResolvers<void>}
 */
function stepLeadWritesHoldingLead2() {
    const lead2Write = Promise.withResolvers();
    onRpc("crm.lead", "web_save", async ({ args }) => {
        expect.step(`web_save ${JSON.stringify(args[0])} ${JSON.stringify(args[1])}`);
        if (args[0][0] === 2) {
            await lead2Write.promise;
        }
    });
    return lead2Write;
}

/**
 * Offline, queues a rename of lead 2 (`queueLeadRename`), then moves the mocked clock
 * a minute past it, so that the lead writes queued next replay after it.
 *
 * @param {OfflinePlugin} plugin
 * @returns {string} the key of the rename
 */
function queueLead2RenameFirst(plugin) {
    const key = queueLeadRename(plugin, 2, "Lead 2 renamed");
    mockDate(new Date(plugin._ormToSync()[key].value.extras.timeStamp + 60_000).toISOString());
    return key;
}

/** The step of the replayed rename of lead 2 (`queueLead2RenameFirst`). */
const LEAD_2_RENAME_STEP = `web_save [2] ${JSON.stringify({ name: "Lead 2 renamed" })}`;

/**
 * Lets the replay held on the rename of lead 2 go on (`stepLeadWritesHoldingLead2`):
 * the rename is answered, and the replay sends the next queued call one second
 * later.
 *
 * @param {OfflinePlugin} plugin
 * @param {PromiseWithResolvers<void>} lead2Write
 * @param {string} renameKey
 */
async function releaseLead2Rename(plugin, lead2Write, renameKey) {
    lead2Write.resolve();
    await waitUntil(() => !(renameKey in plugin._ormToSync()));
    await runAllTimers();
}

test("[Online] card stage move during the replay of the lead's queued form save is sent after it", async () => {
    // Offline root load served from the cache: the pipeline groups (back from the form).
    expect.errors(1);
    const lead2Write = stepLeadWritesHoldingLead2();
    stepRainbowman();
    // The clock is set before the views and the cache are created (see the tests above).
    mockDate("2026-10-02 09:00:00");
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    await openLead(1);
    const plugin = getService(OfflinePlugin);

    // Offline: a write of another lead is queued, then, a minute later, the lead form
    // saves stage B (Qualified).
    await setOffline(true);
    const renameKey = queueLead2RenameFirst(plugin);
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_form_button_save").click();
    await goBack();
    expect.verifyErrors([LEAD_GROUPS_LOAD]);
    const formSave = queued("crm.lead").find(({ key }) => key !== renameKey);
    expect(formSave.value.args).toEqual([[1], { stage_id: STAGE_QUALIFIED }]);
    expect.verifySteps([]);

    // Reconnected: the replay sends the other lead's write first, and is held there,
    // with the lead's queued form save still to be sent.
    await setOffline(false);
    await expect.waitForSteps([LEAD_2_RENAME_STEP]);
    expect(plugin.syncingORM()).toBe(true);
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([renameKey, formSave.key]);

    // Online meanwhile, the card moves the lead to C (Won): its save is not sent ahead
    // of the lead's queued form save. The card already shows the move.
    await moveLeadCard("Lead 1", STAGE_WON, 2);
    await animationFrame();
    expect.verifySteps([]);
    const movedCard = await revealLeadCard("Lead 1");
    if (isSmall()) {
        expect(`${movedCard} select.o_crm_mobile_lead_stage`).toHaveValue(`${STAGE_WON}`);
    } else {
        expect(`.o_kanban_group:eq(2) ${movedCard}`).toHaveCount(1);
    }
    expect.verifySteps([]);

    // The queued form save replays one second later, then the card's save is sent,
    // followed by the online rainbowman lookup of the move: the card's stage wins.
    await releaseLead2Rename(plugin, lead2Write, renameKey);
    await expect.waitForSteps([
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_QUALIFIED })}`,
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_WON })}`,
        "get_rainbowman_message",
    ]);
    await runAllTimers();
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_WON);
    expect(MockServer.env["crm.lead"].browse(2)[0].name).toBe("Lead 2 renamed");
    const card = await revealLeadCard("Lead 1");
    if (isSmall()) {
        expect(`${card} select.o_crm_mobile_lead_stage`).toHaveValue(`${STAGE_WON}`);
    } else {
        expect(`.o_kanban_group:eq(2) ${card}`).toHaveCount(1);
    }
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

test.tags("desktop");
test("[Online] card colour picked during the replay of the lead's queued colour is sent after it", async () => {
    const lead2Write = stepLeadWritesHoldingLead2();
    mockDate("2026-10-02 09:00:00");
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    const plugin = getService(OfflinePlugin);
    const lead1 = ".o_kanban_record:contains(Lead 1)";
    const lead3 = ".o_kanban_record:contains(Lead 3)";

    /** Picks a colour in the menu of a card. */
    async function pickColour(cardSelector, colour) {
        await contains(`${cardSelector} .o_dropdown_kanban .dropdown-toggle`, {
            visible: false,
        }).click();
        await contains(`.o-dropdown--menu .o_colorlist_item_color_${colour}`).click();
    }

    // Offline: a write of another lead is queued, then, a minute later, the card menu
    // of the lead queues colour 3.
    await setOffline(true);
    const renameKey = queueLead2RenameFirst(plugin);
    await pickColour(lead1, 3);
    const queuedColour = queued("crm.lead").find(({ key }) => key !== renameKey);
    expect(queuedColour.value.args).toEqual([[1], { color: 3 }]);
    expect.verifySteps([]);

    // Reconnected: the replay sends the other lead's write first, and is held there.
    await setOffline(false);
    await expect.waitForSteps([LEAD_2_RENAME_STEP]);
    expect(plugin.syncingORM()).toBe(true);

    // A card write the replay has nothing to send before is sent at once: the colour
    // of a lead without queued writes, and a stage move of the lead, whose queued
    // write sets its colour only.
    await pickColour(lead3, 6);
    expect.verifySteps([`web_save [3] ${JSON.stringify({ color: 6 })}`]);
    await contains(lead1).dragAndDrop(".o_kanban_group:eq(1)");
    expect.verifySteps([`web_save [1] ${JSON.stringify({ stage_id: STAGE_QUALIFIED })}`]);

    // The lead's colour picked online meanwhile shows at once, and its save is not
    // sent ahead of the lead's queued colour.
    await pickColour(lead1, 5);
    await animationFrame();
    expect(lead1).toHaveClass("o_kanban_color_5");
    expect.verifySteps([]);

    // The queued colour replays one second later, then the card's colour is sent:
    // the colour picked last wins.
    await releaseLead2Rename(plugin, lead2Write, renameKey);
    await expect.waitForSteps([
        `web_save [1] ${JSON.stringify({ color: 3 })}`,
        `web_save [1] ${JSON.stringify({ color: 5 })}`,
    ]);
    await runAllTimers();
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    const [serverLead] = MockServer.env["crm.lead"].browse(1);
    expect(serverLead.color).toBe(5);
    expect(serverLead.stage_id).toBe(STAGE_QUALIFIED);
    expect(MockServer.env["crm.lead"].browse(3)[0].color).toBe(6);
    expect(`.o_kanban_group:eq(1) ${lead1}`).toHaveClass("o_kanban_color_5");
    expect(lead3).toHaveClass("o_kanban_color_6");
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

test.tags("desktop");
test("[Online] card delete during the replay of the lead's queued form save is sent after it", async () => {
    // Offline root load served from the cache: the pipeline groups (back from the form).
    expect.errors(1);
    const lead2Write = stepLeadWritesHoldingLead2();
    onRpc("crm.lead", "unlink", ({ args }) => {
        expect.step(`unlink ${JSON.stringify(args[0])}`);
    });
    mockDate("2026-10-02 09:00:00");
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    await openLead(1);
    const plugin = getService(OfflinePlugin);

    // Offline: a write of another lead is queued, then, a minute later, the lead form
    // saves a new expected revenue.
    await setOffline(true);
    const renameKey = queueLead2RenameFirst(plugin);
    await contains(".o_field_widget[name=expected_revenue] input").edit("1800");
    await contains(".o_form_button_save").click();
    await goBack();
    expect.verifyErrors([LEAD_GROUPS_LOAD]);
    const formSave = queued("crm.lead").find(({ key }) => key !== renameKey);
    expect(formSave.value.args).toEqual([[1], { expected_revenue: 1800 }]);

    // Reconnected: the replay sends the other lead's write first, and is held there.
    await setOffline(false);
    await expect.waitForSteps([LEAD_2_RENAME_STEP]);
    expect(plugin.syncingORM()).toBe(true);

    // Deleted online meanwhile from its card menu, the lead is not deleted ahead of its
    // queued form save, which would then fail on the deleted lead and stay parked.
    await contains(".o_kanban_record:contains(Lead 1) .o_dropdown_kanban .dropdown-toggle", {
        visible: false,
    }).click();
    await contains(".o-dropdown--menu .dropdown-item:contains(Delete)").click();
    await contains(".modal-footer .btn-danger").click();
    await animationFrame();
    expect.verifySteps([]);

    // The queued form save replays one second later, then the delete is sent.
    await releaseLead2Rename(plugin, lead2Write, renameKey);
    await expect.waitForSteps([
        `web_save [1] ${JSON.stringify({ expected_revenue: 1800 })}`,
        "unlink [1]",
    ]);
    await runAllTimers();
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].search_count([["id", "=", 1]])).toBe(0);
    expect(".o_kanban_record:contains(Lead 1)").toHaveCount(0);
    expect(".o_menu_systray .o_offline_systray .fa-exclamation-circle").toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

test.tags("desktop");
test("[Online] card stage move waiting for the replay is queued after the lead's form save when the connection drops", async () => {
    // Offline root load served from the cache: the pipeline groups (back from the form).
    expect.errors(1);
    const lead2Write = stepLeadWritesHoldingLead2();
    stepRainbowman();
    mockDate("2026-10-02 09:00:00");
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    await openLead(1);
    const plugin = getService(OfflinePlugin);

    // Offline: a write of another lead, then the lead form's stage B (Qualified).
    await setOffline(true);
    const renameKey = queueLead2RenameFirst(plugin);
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_form_button_save").click();
    await goBack();
    expect.verifyErrors([LEAD_GROUPS_LOAD]);
    const formSave = queued("crm.lead").find(({ key }) => key !== renameKey);

    // Reconnected, the replay is held on the other lead's write, and the card moves the
    // lead to C (Won): its save waits for the lead's queued form save.
    await setOffline(false);
    await expect.waitForSteps([LEAD_2_RENAME_STEP]);
    await moveLeadCard("Lead 1", STAGE_WON, 2);
    expect.verifySteps([]);

    // The connection drops while it waits: the replay still has the lead's form save
    // to send, so the card's save keeps waiting, neither sent nor queued.
    await setOffline(true);
    await animationFrame();
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([renameKey, formSave.key]);
    expect(".o_kanban_group:eq(2) .o_kanban_record:contains(Lead 1)").toHaveCount(1);
    expect.verifySteps([]);
    // The other lead's write is answered; the replay stops at the lead's form save,
    // which the lost connection keeps queued. That ends the card's wait, with the
    // connection still lost: the framework queues the card's save, after the lead's
    // form save. Nothing is sent.
    lead2Write.resolve();
    await waitUntil(() => !(renameKey in plugin._ormToSync()));
    await runAllTimers();
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    const cardSave = queued("crm.lead").find(({ key }) => key !== formSave.key);
    expect(cardSave.value.args).toEqual([[1], { stage_id: STAGE_WON }]);
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([formSave.key, cardSave.key]);
    expect(".o_kanban_group:eq(2) .o_kanban_record:contains(Lead 1)").toHaveCount(1);
    expect.verifySteps([]);

    // Reconnected, the replay sends the form save, then the card's move: the card's
    // stage, chosen last, is the one the server keeps.
    await setOffline(false);
    await runAllTimers();
    await expect.waitForSteps([
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_QUALIFIED })}`,
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_WON })}`,
    ]);
    await runAllTimers();
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_WON);
    expect(".o_kanban_group:eq(2) .o_kanban_record:contains(Lead 1)").toHaveCount(1);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

test.tags("desktop");
test("[Online] card stage move waiting for the replay is sent once the lead's queued form save is rejected", async () => {
    // Offline root load served from the cache: the pipeline groups (back from the form).
    expect.errors(1);
    // Registered first, so that it runs after the step of the write it rejects.
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (args[0][0] === 1 && args[1].stage_id === STAGE_QUALIFIED) {
            throw makeServerError({ message: "Stage locked" });
        }
    });
    const lead2Write = stepLeadWritesHoldingLead2();
    stepRainbowman();
    mockDate("2026-10-02 09:00:00");
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    await openLead(1);
    const plugin = getService(OfflinePlugin);

    await setOffline(true);
    const renameKey = queueLead2RenameFirst(plugin);
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_form_button_save").click();
    await goBack();
    expect.verifyErrors([LEAD_GROUPS_LOAD]);

    await setOffline(false);
    await expect.waitForSteps([LEAD_2_RENAME_STEP]);
    await moveLeadCard("Lead 1", STAGE_WON, 2);
    expect.verifySteps([]);

    // The server rejects the queued form save, which parks: no write ahead of the card's
    // save remains, so it is sent at once, followed by its rainbowman lookup.
    await releaseLead2Rename(plugin, lead2Write, renameKey);
    await expect.waitForSteps([
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_QUALIFIED })}`,
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_WON })}`,
        "get_rainbowman_message",
    ]);
    await runAllTimers();
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expectParked("crm.lead", "Stage locked");
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_WON);
    expect(".o_kanban_group:eq(2) .o_kanban_record:contains(Lead 1)").toHaveCount(1);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

// Pipeline card writes and the connection state the framework reports (R1 on cards):
// a card write is neither released ahead of the lead's queued writes by a reported
// lost connection, nor sent ahead of them while the connection is reported lost
// although it is back.

test("[Online] card stage move held during a replay stays held when a lost connection is reported", async () => {
    // Offline root load served from the cache: the pipeline groups (back from the form).
    expect.errors(1);
    const lead2Write = stepLeadWritesHoldingLead2();
    stepRainbowman();
    const network = mockNetwork();
    // The clock is set before the views and the cache are created (see the tests above).
    mockDate("2026-10-02 09:00:00");
    await openPipeline();
    await flushStartupSync();
    await openLead(1);
    const plugin = getService(OfflinePlugin);
    serializeReplays(plugin);

    // Offline: a write of another lead is queued, then, a minute later, the lead form
    // saves stage B (Qualified).
    await loseConnection(network);
    const renameKey = queueLead2RenameFirst(plugin);
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_form_button_save").click();
    await goBack();
    expect.verifyErrors([LEAD_GROUPS_LOAD]);
    const formSave = queued("crm.lead").find(({ key }) => key !== renameKey);
    expect(formSave.value.args).toEqual([[1], { stage_id: STAGE_QUALIFIED }]);

    // Reconnected: the replay sends the other lead's write first, and is held there.
    // Online meanwhile, the card moves the lead to C (Won): its save waits for the
    // lead's queued form save.
    network.down = false;
    plugin.setOffline(false);
    await expect.waitForSteps([LEAD_2_RENAME_STEP]);
    expect(plugin.syncingORM()).toBe(true);
    await moveLeadCard("Lead 1", STAGE_WON, 2);
    expect.verifySteps([]);

    // A request fails meanwhile: the framework reports the connection lost while it is
    // in fact up. The running replay still sends the lead's form save, so the card's
    // save is neither sent ahead of it nor queued: it keeps waiting.
    plugin.setOffline(true);
    await animationFrame();
    expect.verifySteps([]);
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([renameKey, formSave.key]);

    // The replay goes on, its answers report the connection back, it sends the lead's
    // form save, then the card's save is sent, with its rainbowman lookup: the card's
    // stage, chosen last, is the one the server keeps.
    await releaseLead2Rename(plugin, lead2Write, renameKey);
    await expect.waitForSteps([
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_QUALIFIED })}`,
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_WON })}`,
        "get_rainbowman_message",
    ]);
    await runAllTimers();
    await animationFrame();
    expect(plugin.isOffline()).toBe(false);
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_WON);
    expect(MockServer.env["crm.lead"].browse(2)[0].name).toBe("Lead 2 renamed");
    const card = await revealLeadCard("Lead 1");
    if (isSmall()) {
        expect(`${card} select.o_crm_mobile_lead_stage`).toHaveValue(`${STAGE_WON}`);
    } else {
        expect(`.o_kanban_group:eq(2) ${card}`).toHaveCount(1);
    }
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

test("[Offline] card stage move made before the connection is seen back replays after the lead's queued form save", async () => {
    // Offline root load served from the cache: the pipeline groups (back from the form).
    expect.errors(1);
    stepLeadWrites();
    stepRainbowman();
    const network = mockNetwork();
    await openPipeline();
    await flushStartupSync();
    await openLead(1);
    const plugin = getService(OfflinePlugin);

    // T1, offline: the lead form saves stage B (Qualified), queued.
    await loseConnection(network);
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_form_button_save").click();
    await goBack();
    expect.verifyErrors([LEAD_GROUPS_LOAD]);
    const [formSave] = queued("crm.lead");
    expect(formSave.value.args).toEqual([[1], { stage_id: STAGE_QUALIFIED }]);

    // T2: the connection is back, while the framework still reports it lost, when the
    // card moves the lead to C (Won). The card's save is not sent ahead of the lead's
    // queued form save, whose replay would overwrite it: it is queued after it, as an
    // offline save is, and the connection check it starts finds the connection back,
    // so the replay sends the form save first and the card's stage last. A queued move
    // is an offline move: it does no rainbowman lookup.
    network.down = false;
    expect(plugin.isOffline()).toBe(true);
    await moveLeadCard("Lead 1", STAGE_WON, 2);
    await expect.waitForSteps([`web_save [1] ${JSON.stringify({ stage_id: STAGE_QUALIFIED })}`]);
    await runAllTimers();
    await expect.waitForSteps([`web_save [1] ${JSON.stringify({ stage_id: STAGE_WON })}`]);
    await runAllTimers();
    await animationFrame();
    expect(plugin.isOffline()).toBe(false);
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_WON);
    const card = await revealLeadCard("Lead 1");
    if (isSmall()) {
        expect(`${card} select.o_crm_mobile_lead_stage`).toHaveValue(`${STAGE_WON}`);
    } else {
        expect(`.o_kanban_group:eq(2) ${card}`).toHaveCount(1);
    }
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

test.tags("desktop");
test("[Offline] card moved again before the connection is seen back replays after a later queued write of its stage", async () => {
    stepLeadWrites();
    stepRainbowman();
    const network = mockNetwork();
    // The clock is set before the views and the cache are created (see the tests above).
    mockDate("2026-10-02 09:00:00");
    await openPipeline();
    await flushStartupSync();
    const plugin = getService(OfflinePlugin);
    const lead1 = ".o_kanban_record:contains(Lead 1)";

    // T1, offline: the card moves the lead to B (Qualified), queued as the card's own
    // save. T2: a later write of the lead's stage, A (New), made through another record
    // of the lead (another tab's form), is queued after it.
    await loseConnection(network);
    await contains(lead1).dragAndDrop(".o_kanban_group:eq(1)");
    const [cardMove] = queued("crm.lead");
    expect(cardMove.value.args).toEqual([[1], { stage_id: STAGE_QUALIFIED }]);
    const laterKey = plugin.scheduleORM(
        "crm.lead",
        "web_save",
        [[1], { stage_id: STAGE_NEW }],
        { context: callContext(PIPELINE_ACTION.context), specification: {} },
        {
            extras: {
                actionId: PIPELINE_ACTION.id,
                actionName: PIPELINE_ACTION.name,
                viewType: "form",
                displayName: "Lead 1",
                timeStamp: cardMove.value.extras.timeStamp + 1,
                changes: { stage_id: { id: STAGE_NEW, display_name: "New" } },
                originalValues: { stage_id: { id: STAGE_QUALIFIED, display_name: "Qualified" } },
            },
        }
    );

    // T3: the connection is back, while the framework still reports it lost, when the
    // same card moves the lead to C (Won). Merged into the card's own queued save, the
    // move would replay at T1, before the later write: it is queued as an entry of its
    // own after that write instead, and the card's earlier move stays as it was queued.
    // The replay its connection check starts sends the three writes in that order.
    network.down = false;
    await contains(lead1).dragAndDrop(".o_kanban_group:eq(2)");
    await expect.waitForSteps([`web_save [1] ${JSON.stringify({ stage_id: STAGE_QUALIFIED })}`]);
    await runAllTimers();
    await expect.waitForSteps([`web_save [1] ${JSON.stringify({ stage_id: STAGE_NEW })}`]);
    await runAllTimers();
    await expect.waitForSteps([`web_save [1] ${JSON.stringify({ stage_id: STAGE_WON })}`]);
    await runAllTimers();
    await animationFrame();
    expect(laterKey in plugin._ormToSync()).toBe(false);
    expect(plugin.syncingORM()).toBe(false);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_WON);
    expect(`.o_kanban_group:eq(2) ${lead1}`).toHaveCount(1);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});



test.tags("desktop");
test("[Online] card writes with no replay running are sent at once", async () => {
    stepLeadWrites();
    stepRainbowman();
    onRpc("crm.lead", "unlink", ({ args }) => {
        expect.step(`unlink ${JSON.stringify(args[0])}`);
    });
    await openPipeline();
    await flushStartupSync();
    expect(getService(OfflinePlugin).syncingORM()).toBe(false);
    /** The menu toggle of a lead card. */
    const menuToggle = (name) =>
        `.o_kanban_record:contains(${name}) .o_dropdown_kanban .dropdown-toggle`;

    // Each card write issues its requests within the gesture, as before: no timer has
    // to run for any of them to be sent.
    await contains(".o_kanban_record:contains(Lead 1)").dragAndDrop(".o_kanban_group:eq(2)");
    expect.verifySteps([
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_WON })}`,
        "get_rainbowman_message",
    ]);
    await contains(menuToggle("Lead 2"), { visible: false }).click();
    await contains(".o-dropdown--menu .o_colorlist_item_color_4").click();
    expect.verifySteps([`web_save [2] ${JSON.stringify({ color: 4 })}`]);
    expect(".o_kanban_record:contains(Lead 2)").toHaveClass("o_kanban_color_4");
    await contains(menuToggle("Lead 3"), { visible: false }).click();
    await contains(".o-dropdown--menu .dropdown-item:contains(Delete)").click();
    await contains(".modal-footer .btn-danger").click();
    expect.verifySteps(["unlink [3]"]);
    await animationFrame();
    expect(".o_kanban_record:contains(Lead 3)").toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
});

test("[Offline] lead form opened after a card move shows its queued stage, not as an edit", async () => {
    // Offline root loads served from the cache: the lead form, the pipeline groups back
    // from it, and the lead form again.
    expect.errors(3);
    stepLeadWrites();
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    // Visited online, so that its form is available offline.
    await openLead(1);
    await goBack();

    await setOffline(true);
    await moveLeadCard("Lead 1", STAGE_QUALIFIED, 1);
    const [cardMove] = queued("crm.lead");
    expect(cardMove.value.args).toEqual([[1], { stage_id: STAGE_QUALIFIED }]);

    // The form has no queued save of its own: it shows the card's stage, unchanged.
    await openLead(1);
    expect(currentStageSelector()).toHaveText("Qualified");
    expect(".o_form_status_indicator_buttons").toHaveClass("invisible");
    await goBack();
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([cardMove.key]);

    // A stage then saved in the form replays after the card move, even in the same
    // millisecond.
    await openLead(1);
    patchWithCleanup(Date, { now: () => cardMove.value.extras.timeStamp });
    await selectStage(STAGE_NEW, "New");
    await contains(".o_form_button_save").click();
    const [first, second] = queued("crm.lead");
    expect(first.key).toBe(cardMove.key);
    expect(second.value.args).toEqual([[1], { stage_id: STAGE_NEW }]);
    expect(second.value.extras.timeStamp).toBe(cardMove.value.extras.timeStamp + 1);
    expect.verifySteps([]);
    expect.verifyErrors([LEAD_RECORD_LOAD, LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] lead form edit after an offline won keeps the won last", async () => {
    stepLeadWrites();
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    // Stage B saved (T1), then Won (T2), then a revenue edit saved: the won call
    // writes no revenue, so the edit joins the form's queued save, before the won.
    await setOffline(true);
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_form_button_save").click();
    await contains(WON_BUTTON).click();
    await contains(".o_field_widget[name=expected_revenue] input").edit("15");
    await contains(".o_form_button_save").click();
    const context = queuedContext(PIPELINE_ACTION.context);
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_QUALIFIED, expected_revenue: 15 }],
            kwargs: { context, specification: {} },
        },
        pipelineLeadWonCall(),
    ]);

    await reconnect(setOffline);
    await expect.waitForSteps([
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_QUALIFIED, expected_revenue: 15 })}`,
        pipelineLeadWonCall(),
    ]);
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0]).toMatchObject({
        stage_id: STAGE_WON,
        won_status: "won",
        probability: 100,
        expected_revenue: 15,
    });
    await animationFrame();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect.verifySteps([]);
});

test("[Offline] lead stage saved after an offline won replays after the won", async () => {
    stepLeadWrites();
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();
    // A held clock: every call is queued in the same millisecond.
    const clock = Date.now();
    patchWithCleanup(Date, { now: () => clock });

    // Stage B saved, then Won, then stage A saved: the won call writes the stage, so
    // the form's queued save (which holds nothing else the won writes) moves after it.
    await setOffline(true);
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_form_button_save").click();
    await contains(WON_BUTTON).click();
    const [formSave, won] = queued("crm.lead");
    expect(won.value.method).toBe("action_set_won");
    await selectStage(STAGE_NEW, "New");
    await contains(".o_form_button_save").click();
    const context = queuedContext(PIPELINE_ACTION.context);
    expect(queuedCalls("crm.lead")).toEqual([
        pipelineLeadWonCall(),
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_NEW }],
            kwargs: { context, specification: {} },
        },
    ]);
    const entries = queued("crm.lead");
    expect(entries[1].key).toBe(formSave.key);
    expect(entries[1].value.extras.timeStamp).toBe(won.value.extras.timeStamp + 1);

    await reconnect(setOffline);
    await expect.waitForSteps([
        pipelineLeadWonCall(),
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_NEW })}`,
    ]);
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_NEW);
});

test("[Offline] reopened lead stage saved after a queued won is queued again after the won", async () => {
    // Offline root loads served from the cache: back to the pipeline and the reopened
    // lead, twice.
    expect.errors(4);
    stepLeadWrites();
    const controllers = captureLeadForms();
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    // Stage B and a probability saved (T1), then Won (T2); the lead is reopened.
    await setOffline(true);
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_field_widget[name=probability] input").edit("42");
    await contains(".o_form_button_save").click();
    await contains(WON_BUTTON).click();
    const [formSave, won] = queued("crm.lead");
    await goBack();
    await openLead(1);
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(currentStageSelector()).toHaveText("Qualified");

    // Stage A saved: the form's queued save also holds the probability the won writes,
    // so it keeps its time (its values stay before the won) and the stage is queued
    // again in a follow-up write after the won.
    await selectStage(STAGE_NEW, "New");
    await contains(".o_form_button_save").click();
    const context = queuedContext(PIPELINE_ACTION.context);
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_NEW }],
            kwargs: { context, specification: {} },
        },
        pipelineLeadWonCall(),
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_NEW }],
            kwargs: { context, specification: {} },
        },
    ]);
    const [, , followUp] = queued("crm.lead");
    expect(queued("crm.lead")[0].key).toBe(formSave.key);
    expect(queued("crm.lead")[0].value.extras.timeStamp).toBe(formSave.value.extras.timeStamp);
    expect(followUp.value.extras).toMatchObject({
        crmFollowUp: true,
        viewType: "form",
        changes: { stage_id: { id: STAGE_NEW, display_name: "New" } },
    });
    expect(followUp.value.extras.timeStamp).toBeGreaterThan(won.value.extras.timeStamp);

    // Reopened again, the form restores its own queued save (not the follow-up),
    // shows the follow-up's stage and holds no unsaved edit.
    await goBack();
    await openLead(1);
    expect(controllers[0].model.root.offlineId).toBe(formSave.key);
    expect(currentStageSelector()).toHaveText("New");
    expect(".o_form_status_indicator_buttons").toHaveClass("invisible");
    expect(queued("crm.lead")).toHaveLength(3);

    await reconnect(setOffline);
    await expect.waitForSteps([
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_NEW })}`,
        pipelineLeadWonCall(),
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_NEW })}`,
    ]);
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_NEW);
    expect.verifyErrors([LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD, LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] lead form save overriding part of a later write keeps its older values first", async () => {
    // Offline root loads served from the cache: back to the pipeline and the reopened
    // lead.
    expect.errors(2);
    stepLeadWrites();
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    // T1: the form saves a name and stage B.
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 1 form");
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_form_button_save").click();
    const [formSave] = queued("crm.lead");
    expect(formSave.value.args).toEqual([[1], { name: "Lead 1 form", stage_id: STAGE_QUALIFIED }]);
    // T2 = T1 + 1 min: the lead's form of another action (another Record) saves another
    // name and stage C, queued as the framework queues a form save.
    const otherSave = getService(OfflinePlugin).scheduleORM(
        "crm.lead",
        "web_save",
        [[1], { name: "Lead 1 elsewhere", stage_id: STAGE_WON }],
        { context: callContext(), specification: {} },
        {
            extras: {
                actionId: TEAM_LEADS_ACTION_ID,
                actionName: TEAM_LEADS_ACTION.name,
                viewType: "form",
                displayName: "Lead 1 elsewhere",
                timeStamp: formSave.value.extras.timeStamp + 60_000,
                changes: {
                    name: "Lead 1 elsewhere",
                    stage_id: { id: STAGE_WON, display_name: "Won" },
                },
                originalValues: {
                    name: "Lead 1",
                    stage_id: { id: STAGE_NEW, display_name: "New" },
                },
            },
        }
    );

    // Reopened, the form shows the later name and stage, not as edits.
    await goBack();
    await openLead(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 elsewhere");
    expect(currentStageSelector()).toHaveText("Won");
    expect(".o_form_status_indicator_buttons").toHaveClass("invisible");

    // Stage A saved: the later write also writes the name, so the form's queued save
    // keeps its time (its older name stays before the later one) and the stage is
    // queued again after the later write.
    await selectStage(STAGE_NEW, "New");
    await contains(".o_form_button_save").click();
    expect(queued("crm.lead").map(({ key, value }) => [key, value.args])).toEqual([
        [formSave.key, [[1], { name: "Lead 1 form", stage_id: STAGE_NEW }]],
        [otherSave, [[1], { name: "Lead 1 elsewhere", stage_id: STAGE_WON }]],
        [queued("crm.lead")[2].key, [[1], { stage_id: STAGE_NEW }]],
    ]);

    await reconnect(setOffline);
    await expect.waitForSteps([
        `web_save [1] ${JSON.stringify({ name: "Lead 1 form", stage_id: STAGE_NEW })}`,
        `web_save [1] ${JSON.stringify({ name: "Lead 1 elsewhere", stage_id: STAGE_WON })}`,
        `web_save [1] ${JSON.stringify({ stage_id: STAGE_NEW })}`,
    ]);
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0]).toMatchObject({
        name: "Lead 1 elsewhere",
        stage_id: STAGE_NEW,
    });
    await animationFrame();
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 elsewhere");
    expect(currentStageSelector()).toHaveText("New");
    expect.verifyErrors([LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] parked lead save handed to the form keeps its values over a later parked write", async () => {
    // Offline root load served from the cache: the pipeline groups (back from the form).
    expect.errors(1);
    stepLeadWrites();
    const rejection = rejectReplay("crm.lead", "web_save", "Save refused");
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    // Offline, the form saves a name and stage B, then the pipeline card moves the lead
    // to C; both replays are rejected and parked.
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 1 parked");
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_form_button_save").click();
    await goBack();
    await moveLeadCard("Lead 1", STAGE_WON, 2);
    const [formSave, cardMove] = queued("crm.lead");
    expect(cardMove.value.args).toEqual([[1], { stage_id: STAGE_WON }]);
    rejection.reject = true;
    await reconnect(setOffline);
    await runAllTimers();
    rejection.reject = false;
    expect(queued("crm.lead").map(({ key, value }) => [key, Boolean(value.extras.error)])).toEqual([
        [formSave.key, true],
        [cardMove.key, true],
    ]);
    expect.verifySteps([]);

    // Retried from the systray online, the form's parked save is handed over with its
    // own values as unsaved edits, the later parked card move does not replace them,
    // and saving writes them.
    await openSystray();
    await contains(
        ".o_offline_systray_content .o-dropdown-item:contains(Lead 1 parked) .text-truncate"
    ).click();
    await animationFrame();
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([cardMove.key]);
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Lead 1 parked");
    expect(currentStageSelector()).toHaveText("Qualified");
    await contains(".o_form_button_save").click();
    expect.verifySteps([
        `web_save [1] ${JSON.stringify({ name: "Lead 1 parked", stage_id: STAGE_QUALIFIED })}`,
    ]);
    expect(MockServer.env["crm.lead"].browse(1)[0]).toMatchObject({
        name: "Lead 1 parked",
        stage_id: STAGE_QUALIFIED,
    });
    expect.verifyErrors([LEAD_GROUPS_LOAD]);
});

test("[Offline] rejected replay is parked in the offline systray", async () => {
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (args[0][0] === 1) {
            throw makeServerError({ message: "This stage is locked" });
        }
        expect.step(`web_save ${JSON.stringify(args[0])} stage ${args[1].stage_id}`);
    });
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    await setOffline(true);
    await moveLeadCard("Lead 1", STAGE_QUALIFIED, 1);
    await moveLeadCard("Lead 2", STAGE_WON, 2);
    const kwargs = {
        context: queuedContext(PIPELINE_ACTION.context, { default_stage_id: STAGE_NEW }),
        specification: {},
    };
    const rejectedMove = {
        model: "crm.lead",
        method: "web_save",
        args: [[1], { stage_id: STAGE_QUALIFIED }],
        kwargs,
    };
    const replayedMove = {
        model: "crm.lead",
        method: "web_save",
        args: [[2], { stage_id: STAGE_WON }],
        kwargs,
    };
    expect(queuedCalls("crm.lead")).toEqual([rejectedMove, replayedMove]);
    // The mobile lead card (the pipeline card with a sync badge; desktop kanban cards
    // have none) tells a queued write in text.
    if (isSmall()) {
        const card = await revealLeadCard("Lead 1");
        expect(`${card} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");
        expect(`${card} .o_crm_mobile_pending_sync`).toHaveClass("text-bg-warning");
    }

    // Replay: the rejected write is parked, the other one is replayed.
    await reconnect(setOffline);
    await runAllTimers();
    await expect.waitForSteps([`web_save [2] stage ${STAGE_WON}`]);
    expect(queuedCalls("crm.lead")).toEqual([rejectedMove]);
    expect(queued("crm.lead")[0].value.extras.error).toInclude("This stage is locked");
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(STAGE_NEW);
    expect(MockServer.env["crm.lead"].browse(2)[0].stage_id).toBe(STAGE_WON);

    // The systray lists the parked call in red, its error as the row tooltip.
    await openSystray();
    const errorRow = ".o_offline_systray_content .o-dropdown-item div.text-danger";
    expect(errorRow).toHaveCount(1);
    expect(errorRow).toHaveText("Lead 1");
    expect(queryFirst(errorRow).dataset.tooltip).toInclude("This stage is locked");
    expect(".o_offline_systray_content .o-dropdown-item .fa-exclamation-circle").toHaveCount(1);
    await press("Escape");
    await animationFrame();
    // The mobile card tells the failure in text, and the replayed lead's badge is
    // gone; the desktop kanban has no such card.
    if (isSmall()) {
        const card = await revealLeadCard("Lead 1");
        expect(`${card} .o_crm_mobile_pending_sync`).toHaveText("Sync failed");
        expect(`${card} .o_crm_mobile_pending_sync`).toHaveClass("text-bg-danger");
        const replayedCard = await revealLeadCard("Lead 2");
        expect(replayedCard).toHaveCount(1);
        expect(`${replayedCard} .o_crm_mobile_pending_sync`).toHaveCount(0);
    }
    expect(".modal").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);
});

test("[Offline] parked CRM replay errors show their message only in the offline systray", async () => {
    const uid = serverState.userId;
    // Server messages as Odoo builds them: a deleted record (`odoo/orm/fields.py`), a
    // validation, a record access error with its debug-mode record lines
    // (`ir.access`), an activity access error (`mail.activity`) and a message made of
    // ids only (`odoo/orm/fields_relational.py`'s record line).
    const missingLead = `Record does not exist or has been deleted.\n(Record: crm.lead(1,), User: ${uid})`;
    const lockedLead = "A lead in a Won stage cannot be lost. Move it to another stage first.";
    const deniedLead = [
        "Uh-oh! Looks like you have stumbled upon some top-secret records.",
        "",
        `Sorry, Mitchell Admin (id=${uid}) doesn't have 'write' access to:`,
        "- Lead/Opportunity, Lead 3 (crm.lead: 3)",
        "- Lead/Opportunity, Lead 3 bis (crm.lead: 30, company=YourCompany (BE))",
        "",
        "Contact your administrator to request access if necessary.",
    ].join("\n");
    const deniedActivity = [
        "The requested operation cannot be completed due to security restrictions. Please contact your system administrator.",
        "",
        "(Document type: Activity, Operation: write)",
        "",
        `Records: [7], User: ${uid}`,
    ].join("\n");
    const idsOnly = `(Record: 4, User: ${uid})`;
    const missingPartner = `Record does not exist or has been deleted.\n(Record: res.partner(9,), User: ${uid})`;
    const leadErrors = {
        1: { type: "MissingError", message: missingLead },
        2: { type: "ValidationError", message: lockedLead },
        3: { type: "AccessError", message: deniedLead },
    };
    // Every replay below is rejected, as the server would reject it.
    onRpc("crm.lead", "web_save", ({ args }) => {
        throw makeServerError(leadErrors[args[0][0]]);
    });
    onRpc("mail.activity", "action_done", () => {
        throw makeServerError({ type: "AccessError", message: deniedActivity });
    });
    onRpc("mail.activity", "create", () => {
        throw makeServerError({ type: "MissingError", message: idsOnly });
    });
    onRpc("res.partner", "web_save", () => {
        throw makeServerError({ type: "MissingError", message: missingPartner });
    });
    registerInlineViewArchs("res.partner", { [`form,${PARTNER_FORM_VIEW_ID}`]: PARTNER_FORM_ARCH });
    const setOffline = mockOffline();
    const { env } = await makeMockServer();
    const partnerId = env["res.partner"].create({ name: "Azure Interior" });
    await mountWithCleanup(WebClient);
    await flushStartupSync();
    const offlinePlugin = getService(OfflinePlugin);

    /** Reconnects and lets the framework replay its whole queue, one call per second. */
    async function replayAll() {
        await reconnect(setOffline);
        while (offlinePlugin.syncingORM()) {
            await runAllTimers();
            await animationFrame();
        }
    }

    // A non-CRM entry: a contact saved offline from its form, parked on replay.
    await getService("action").doAction({
        type: "ir.actions.act_window",
        res_model: "res.partner",
        res_id: partnerId,
        views: [[PARTNER_FORM_VIEW_ID, "form"]],
    });
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Azure Interior (offline)");
    await contains(".o_form_button_save").click();
    expect(queuedCalls("res.partner").map(({ method, args }) => ({ method, args }))).toEqual([
        { method: "web_save", args: [[partnerId], { name: "Azure Interior (offline)" }] },
    ]);
    await replayAll();

    // CRM entries: three card moves and the two activity calls of the lead activity
    // sheet, parked on replay.
    await getService("action").doAction(PIPELINE_ACTION.id);
    await setOffline(true);
    await moveLeadCard("Lead 1", STAGE_QUALIFIED, 1);
    await moveLeadCard("Lead 2", STAGE_WON, 2);
    await moveLeadCard("Lead 3", STAGE_QUALIFIED, 1);
    const kwargs = { context: user.context };
    const extras = { timeStamp: Date.now(), actionName: "Pipeline", displayName: "Lead 4" };
    offlinePlugin.scheduleORM("mail.activity", "action_done", [[7]], kwargs, { extras });
    const activityVals = { res_model: "crm.lead", res_id: 4, summary: "Call" };
    offlinePlugin.scheduleORM("mail.activity", "create", [[activityVals]], kwargs, {
        extras: { ...extras, displayName: "Lead 4 call" },
    });
    await replayAll();

    // The queue keeps the framework's errors, each entry parked.
    const parkedErrors = (model) =>
        Object.fromEntries(
            queued(model).map(({ value }) => [JSON.stringify(value.args[0]), value.extras.error])
        );
    expect(parkedErrors("crm.lead")).toEqual({
        "[1]": `odoo.exceptions.MissingError - ${missingLead}`,
        "[2]": `odoo.exceptions.ValidationError - ${lockedLead}`,
        "[3]": `odoo.exceptions.AccessError - ${deniedLead}`,
    });
    expect(parkedErrors("mail.activity")).toEqual({
        "[7]": `odoo.exceptions.AccessError - ${deniedActivity}`,
        [JSON.stringify([activityVals])]: `odoo.exceptions.MissingError - ${idsOnly}`,
    });
    expect(parkedErrors("res.partner")).toEqual({
        [`[${partnerId}]`]: `odoo.exceptions.MissingError - ${missingPartner}`,
    });

    // The systray rows: the CRM ones tell the server message only (no exception
    // class, no internal id, a generic message when only ids were given); the contact
    // row keeps the framework's text.
    await openSystray();
    const errorRows = queryAll(".o_offline_systray_content .o-dropdown-item div.text-danger");
    const tooltips = errorRows.map((row) => [row.textContent.trim(), row.dataset.tooltip]);
    expect(Object.fromEntries(tooltips)).toEqual({
        "Lead 1": "Record does not exist or has been deleted.",
        "Lead 2": lockedLead,
        "Lead 3": [
            "Uh-oh! Looks like you have stumbled upon some top-secret records.",
            "",
            "Sorry, Mitchell Admin doesn't have 'write' access to:",
            "- Lead/Opportunity, Lead 3",
            "- Lead/Opportunity, Lead 3 bis",
            "",
            "Contact your administrator to request access if necessary.",
        ].join("\n"),
        "Lead 4": [
            "The requested operation cannot be completed due to security restrictions. Please contact your system administrator.",
            "",
            "(Document type: Activity, Operation: write)",
        ].join("\n"),
        "Lead 4 call": "The server could not apply this change.",
        "Azure Interior (offline)": `odoo.exceptions.MissingError - ${missingPartner}`,
    });
    expect(".o_offline_systray_content .o-dropdown-item .fa-exclamation-circle").toHaveCount(6);
    expect(".o_menu_systray .o_offline_systray .fa-exclamation-circle").toHaveCount(1);
    await press("Escape");
    await animationFrame();
    expect(".modal").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);
});

// -----------------------------------------------------------------------------
// Replay delivery: one delivery per queued CRM call (several tabs, lost answers)
// -----------------------------------------------------------------------------

/**
 * Keys of the queued calls the framework offline store holds.
 *
 * @param {OfflinePlugin} plugin
 * @returns {Promise<string[]>}
 */
async function storedQueueKeys(plugin) {
    const entries = await plugin._idb.getAllEntries(OfflinePlugin.ORM_SYNC_TABLE_NAME);
    return entries.map(({ key }) => key);
}

/**
 * The queued call the framework offline store holds under `key`, parsed.
 *
 * @param {OfflinePlugin} plugin
 * @param {string} key
 */
async function storedQueueValue(plugin, key) {
    return JSON.parse(await plugin._idb.read(OfflinePlugin.ORM_SYNC_TABLE_NAME, key));
}

/**
 * Steps each removal of a queued call from the offline store as `store delete
 * <key>`, and holds the removal of a key set in the returned map until its
 * deferred is resolved.
 *
 * @param {OfflinePlugin} plugin
 * @returns {Map<string, PromiseWithResolvers<void>>}
 */
function holdQueueRemovals(plugin) {
    const held = new Map();
    patchWithCleanup(plugin._idb, {
        delete(table, key) {
            if (table !== OfflinePlugin.ORM_SYNC_TABLE_NAME) {
                return super.delete(...arguments);
            }
            expect.step(`store delete ${key}`);
            const hold = held.get(key);
            if (!hold) {
                return super.delete(table, key);
            }
            return hold.promise.then(() => super.delete(table, key));
        },
    });
    return held;
}

/**
 * Emulates the server's lead create by delivery key (the `crm.lead` `web_save`
 * override): a create (`web_save` without ids) whose context carries the key
 * (`CRM_OFFLINE_CREATE_KEY`) of a lead already created answers with that lead and
 * creates nothing. The mock server also decides the fate of the next lead creates,
 * one per value pushed to the returned `losses`, in order: `null` when it answers
 * the create, `true` when it handles the create before its answer is lost, `false`
 * when the request never reaches it; a loss reaches the page as a lost connection
 * (a 502). The creates after the last value are answered. Each create is
 * stepped as `create <name>`, `create <name> (delivered)` when its key answered it,
 * with ` (answer lost)` appended when its answer is lost, or as `create <name>
 * (request lost)`. The payload (`callPayload`) of each create the server handles is
 * appended to `received`, and any `crm.lead` `search` is stepped as `crm.lead search`.
 *
 * @returns {{losses: (boolean|null)[], received: Object[]}}
 */
function mockLeadCreatesByKey() {
    const state = { losses: [], received: [] };
    const leadIdsByKey = new Map();
    onRpc("crm.lead", "web_save", async (params) => {
        const { args, kwargs, parent } = params;
        if (args[0].length) {
            return;
        }
        const loss = state.losses.length ? state.losses.shift() : null;
        if (loss === false) {
            expect.step(`create ${args[1].name} (request lost)`);
            return new Response("", { status: 502 });
        }
        state.received.push(callPayload(params));
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
        if (loss) {
            expect.step(`${step} (answer lost)`);
            return new Response("", { status: 502 });
        }
        expect.step(step);
        return result;
    });
    onRpc("crm.lead", "search", () => {
        expect.step("crm.lead search");
    });
    return state;
}

/**
 * Queues a lead create as the mobile quick create does offline: the pipeline
 * context with the create's delivery key, and an empty specification.
 *
 * @param {OfflinePlugin} plugin
 * @param {Object} vals the lead values, completed with a stage and a revenue
 * @param {string} key the delivery key
 * @param {number} [timeStamp]
 * @returns {string} its queue key
 */
function queueLeadCreate(plugin, vals, key, timeStamp = Date.now()) {
    return plugin.scheduleORM(
        "crm.lead",
        "web_save",
        [[], { stage_id: STAGE_QUALIFIED, expected_revenue: 30, ...vals }],
        {
            context: { default_type: "opportunity", [CRM_OFFLINE_CREATE_KEY]: key },
            specification: {},
        },
        { extras: { displayName: vals.name, timeStamp } }
    );
}

test("[Offline] a replayed CRM call has left the offline store when the replay ends", async () => {
    onRpc("web_save", ({ model, args }) => {
        expect.step(`${model} web_save ${args[1].name}`);
    });
    const setOffline = mockOffline();
    await makeTestApp();
    await flushStartupSync();
    const plugin = getService(OfflinePlugin);
    const held = holdQueueRemovals(plugin);
    const { env } = MockServer;

    // The last queued call is a lead save: once delivered, the replay holds the
    // replay lock until the offline store no longer has the call, so a tab taking
    // the lock next reads a store without it and does not send it again.
    await setOffline(true);
    const leadKey = plugin.scheduleORM(
        "crm.lead",
        "web_save",
        [[1], { name: "Lead 1 replayed" }],
        { context: {}, specification: {} },
        { extras: { displayName: "Lead 1", timeStamp: Date.now() } }
    );
    held.set(leadKey, Promise.withResolvers());
    await setOffline(false);
    await expect.waitForSteps(["crm.lead web_save Lead 1 replayed", `store delete ${leadKey}`]);
    await animationFrame();
    expect(env["crm.lead"].browse(1)[0].name).toBe("Lead 1 replayed");
    expect(plugin.syncingORM()).toBe(true);
    expect(await storedQueueKeys(plugin)).toEqual([leadKey]);
    held.get(leadKey).resolve();
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(await storedQueueKeys(plugin)).toEqual([]);
    expect(queued("crm.lead")).toEqual([]);
    // The framework's own removal follows, on a store that no longer has the call.
    expect.verifySteps([`store delete ${leadKey}`]);

    // A call of another app is replayed as before: the replay ends while the
    // removal of its call from the offline store is still running.
    const partnerId = env["res.partner"].create({ name: "Partner" });
    await setOffline(true);
    const partnerKey = plugin.scheduleORM(
        "res.partner",
        "web_save",
        [[partnerId], { name: "Partner replayed" }],
        { context: {}, specification: {} },
        { extras: { displayName: "Partner", timeStamp: Date.now() } }
    );
    held.set(partnerKey, Promise.withResolvers());
    await setOffline(false);
    await expect.waitForSteps([
        "res.partner web_save Partner replayed",
        `store delete ${partnerKey}`,
    ]);
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(await storedQueueKeys(plugin)).toEqual([partnerKey]);
    held.get(partnerKey).resolve();
    await animationFrame();
    expect(await storedQueueKeys(plugin)).toEqual([]);
    expect(env["res.partner"].browse(partnerId)[0].name).toBe("Partner replayed");
    expect.verifySteps([]);
});

test("[Offline] queued lead create whose replay answer is lost is sent again with its delivery key", async () => {
    const server = mockLeadCreatesByKey();
    const setOffline = mockOffline();
    await makeTestApp();
    await flushStartupSync();
    const plugin = getService(OfflinePlugin);
    const { env } = MockServer;
    const countLeads = (name) => env["crm.lead"].search_count([["name", "=", name]]);
    const deliveryKey = "0123456789abcdef".repeat(2);

    // The replay's create reaches the server, which creates the lead, but its answer
    // is lost: the replay stops, and the create stays queued (not parked), unchanged
    // with its delivery key, in memory and in the offline store.
    await setOffline(true);
    const key = queueLeadCreate(plugin, { name: "Lost Lead" }, deliveryKey);
    const queuedCall = JSON.parse(JSON.stringify(queuedCalls("crm.lead")));
    server.losses.push(true);
    await setOffline(false);
    await expect.waitForSteps(["create Lost Lead (answer lost)"]);
    await animationFrame();
    expect(plugin.isOffline()).toBe(true);
    expect(countLeads("Lost Lead")).toBe(1);
    const [entry] = queued("crm.lead");
    expect(entry.key).toBe(key);
    expect(entry.value.extras.error).toBe(undefined);
    expect(queuedCalls("crm.lead")).toEqual(queuedCall);
    expect(await storedQueueValue(plugin, key)).toEqual(JSON.parse(JSON.stringify(entry.value)));

    // The next replay sends the very same call, key included, which the server
    // answers with the lead it created: one lead, and nothing left to replay. No
    // lookup is sent.
    await reconnect(setOffline);
    await expect.waitForSteps(["create Lost Lead (delivered)"]);
    expect(server.received).toHaveLength(2);
    expect(server.received[1]).toEqual(server.received[0]);
    expect(server.received[0].args).toEqual(queuedCall[0].args);
    expect(server.received[0].kwargs.context).toMatchObject(queuedCall[0].kwargs.context);
    expect(server.received[0].kwargs.context[CRM_OFFLINE_CREATE_KEY]).toBe(deliveryKey);
    expect(countLeads("Lost Lead")).toBe(1);
    expect(queued("crm.lead")).toEqual([]);
    expect(await storedQueueKeys(plugin)).toEqual([]);
    expect(plugin.syncingORM()).toBe(false);
    expect.verifySteps([]);
});

// Refine D1.2 (R2): a lead created in the form offline, then saved online while its own
// create replays, is created once and keeps the values of that save.

/**
 * Emulates the server's keyed lead create (the `crm.lead` `web_save` override) for the
 * lead form: a create (`web_save` without ids) whose context carries a delivery key
 * (`CRM_OFFLINE_CREATE_KEY`) creates its lead once; a later delivery of that key writes
 * its values on that lead and answers as a save of it. Each create is stepped as
 * `replayed create <name>` (a queued call: its context names the user who queued it,
 * `CRM_OFFLINE_UID_KEY`) or `online create <name>`, with ` (delivered)` appended when
 * its key answered it. The answer of the first replayed create waits for
 * `replayAnswer`, and is a lost connection (a 502) once `loseReplayAnswer` is set. The
 * payload (`callPayload`) of each create is appended to `received`.
 *
 * @returns {{
 *  leadIdsByKey: Map<string, number>,
 *  received: Object[],
 *  replayAnswer: PromiseWithResolvers<void>,
 *  loseReplayAnswer: boolean,
 * }}
 */
function mockFormLeadCreatesByKey() {
    const state = {
        leadIdsByKey: new Map(),
        received: [],
        replayAnswer: Promise.withResolvers(),
        loseReplayAnswer: false,
    };
    let heldReplay = false;
    onRpc("crm.lead", "web_save", async (params) => {
        const { args, kwargs, parent } = params;
        if (args[0].length) {
            return;
        }
        state.received.push(callPayload(params));
        const context = kwargs.context || {};
        const key = context[CRM_OFFLINE_CREATE_KEY];
        const replayed = CRM_OFFLINE_UID_KEY in context;
        const step = `${replayed ? "replayed" : "online"} create ${args[1].name}`;
        const leads = MockServer.env["crm.lead"];
        if (state.leadIdsByKey.has(key)) {
            const id = state.leadIdsByKey.get(key);
            leads.write([id], args[1]);
            expect.step(`${step} (delivered)`);
            return leads.web_read([id], kwargs.specification);
        }
        const result = await parent();
        if (typeof key === "string") {
            state.leadIdsByKey.set(key, result[0].id);
        }
        expect.step(step);
        if (replayed && !heldReplay) {
            heldReplay = true;
            await state.replayAnswer.promise;
            if (state.loseReplayAnswer) {
                return new Response("", { status: 502 });
            }
        }
        return result;
    });
    return state;
}

/**
 * Opens the new-lead form of the "Leads" action online (so it is cached), then saves a
 * lead named `name` in it offline: its create is queued, with a delivery key.
 *
 * @param {string} name
 * @returns {Promise<{setOffline: Function, deliveryKey: string}>}
 */
async function queueFormLeadCreate(name) {
    defineActions([
        {
            id: 2,
            xml_id: "crm.crm_lead_all_leads",
            name: "Leads",
            res_model: "crm.lead",
            views: [
                [false, "list"],
                [false, "form"],
            ],
        },
    ]);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(2);
    await contains(".o_list_button_add").click();
    await flushStartupSync();
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit(name);
    await contains(".o_form_button_save").click();
    const [create] = queuedCalls("crm.lead");
    const deliveryKey = create.kwargs.context[CRM_OFFLINE_CREATE_KEY];
    expect(deliveryKey).toMatch(/^[0-9a-f]{32}$/);
    expect(create.args).toEqual([[], create.args[1]]);
    expect(create.args[1]).toMatchObject({ name, type: "opportunity" });
    expect(create.kwargs).toEqual({
        context: { ...queuedContext(), [CRM_OFFLINE_CREATE_KEY]: deliveryKey },
        specification: {},
    });
    return { setOffline, deliveryKey };
}

test("[Offline] lead created in the form offline and saved online during its replay is created once", async () => {
    const server = mockFormLeadCreatesByKey();
    const controllers = captureFormControllers();
    const { setOffline, deliveryKey } = await queueFormLeadCreate("R2 Offline Lead");
    const plugin = getService(OfflinePlugin);
    expect.verifySteps([]);

    // Back online, the replay sends the queued create: the server creates the lead,
    // and its answer is still on its way.
    await setOffline(false);
    await runAllTimers();
    await expect.waitForSteps(["replayed create R2 Offline Lead"]);
    expect(plugin.syncingORM()).toBe(true);

    // Meanwhile the user saves the still-new lead with another name: the save waits
    // for the replay of its create.
    await contains(".o_field_widget[name=name] input").edit("R2 Online Lead");
    await contains(".o_form_button_save").click();
    await runAllTimers();
    await animationFrame();
    expect.verifySteps([]);

    // Once the create is replayed, the save is sent, with the create's delivery key:
    // it writes its values on the lead the replay created. One lead, holding them, is
    // the form's record.
    server.replayAnswer.resolve();
    await runAllTimers();
    await animationFrame();
    await expect.waitForSteps(["online create R2 Online Lead (delivered)"]);
    const leadId = server.leadIdsByKey.get(deliveryKey);
    const { env } = MockServer;
    expect(
        env["crm.lead"].search_read([["name", "in", ["R2 Offline Lead", "R2 Online Lead"]]], ["name"])
    ).toEqual([{ id: leadId, name: "R2 Online Lead" }]);
    expect(server.received).toHaveLength(2);
    expect(server.received[1].args[0]).toEqual([]);
    expect(server.received[1].kwargs.context[CRM_OFFLINE_CREATE_KEY]).toBe(deliveryKey);
    expect(server.received[1].kwargs.context).not.toInclude(CRM_OFFLINE_UID_KEY);
    expect(controllers.at(-1).model.root.resId).toBe(leadId);
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("R2 Online Lead");
    expect(".o_list_view").toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
    expect(plugin.syncingORM()).toBe(false);
    expect.verifySteps([]);
});

test("[Offline] lead form save during a create replay whose answer is lost is queued into that create", async () => {
    const server = mockFormLeadCreatesByKey();
    server.loseReplayAnswer = true;
    const { setOffline, deliveryKey } = await queueFormLeadCreate("R2 Lost Lead");
    const [{ key }] = queued("crm.lead");

    // The replay's create reaches the server, which creates the lead; the user saves
    // the still-new lead with another name before the answer comes back.
    await setOffline(false);
    await runAllTimers();
    await expect.waitForSteps(["replayed create R2 Lost Lead"]);
    await contains(".o_field_widget[name=name] input").edit("R2 Lost Lead edited");
    await contains(".o_form_button_save").click();
    await runAllTimers();
    expect.verifySteps([]);

    // The answer is lost: the replay stops with the create still queued, so the held
    // save is not sent, which would let that older create overwrite it: it is queued
    // into the create, with the create's delivery key.
    server.replayAnswer.resolve();
    await animationFrame();
    expect.verifySteps([]);
    const [entry] = queued("crm.lead");
    expect(queued("crm.lead")).toHaveLength(1);
    expect(entry.key).toBe(key);
    expect(entry.value.extras.error).toBe(undefined);
    expect(entry.value.args).toEqual([[], entry.value.args[1]]);
    expect(entry.value.args[1]).toMatchObject({ name: "R2 Lost Lead edited" });
    expect(entry.value.kwargs.context[CRM_OFFLINE_CREATE_KEY]).toBe(deliveryKey);

    // The next replay delivers that create again: the server writes its values on the
    // lead it created. One lead, with the values of the user's last save.
    await reconnect(setOffline);
    await expect.waitForSteps(["replayed create R2 Lost Lead edited (delivered)"]);
    const { env } = MockServer;
    expect(
        env["crm.lead"].search_read([["name", "in", ["R2 Lost Lead", "R2 Lost Lead edited"]]], ["name"])
    ).toEqual([{ id: server.leadIdsByKey.get(deliveryKey), name: "R2 Lost Lead edited" }]);
    expect(server.received).toHaveLength(2);
    expect(queued("crm.lead")).toEqual([]);
    expect.verifySteps([]);
});


test("[Offline] lost lead creates: each delivery key is answered with its own lead only", async () => {
    const server = mockLeadCreatesByKey();
    const setOffline = mockOffline();
    await makeTestApp();
    await flushStartupSync();
    const plugin = getService(OfflinePlugin);
    const { env } = MockServer;
    const prospects = () =>
        env["crm.lead"]
            .search_read([["name", "=", "Repeat Prospect"]], ["contact_name", "expected_revenue"])
            .map(({ contact_name, expected_revenue }) => [contact_name, expected_revenue]);
    const aliceKey = "0123456789abcdef".repeat(2);
    const bobKey = "fedcba9876543210".repeat(2);

    // Two creates of one name in one stage with other values, as two quick creates
    // (in two tabs, say) queue them: each carries its own delivery key.
    await setOffline(true);
    const aliceCreate = { name: "Repeat Prospect", contact_name: "Alice", expected_revenue: 10 };
    const bobCreate = { name: "Repeat Prospect", contact_name: "Bob", expected_revenue: 20 };
    const aliceEntry = queueLeadCreate(plugin, aliceCreate, aliceKey);
    const bobEntry = queueLeadCreate(plugin, bobCreate, bobKey, Date.now() + 1);

    // Alice's lead is created, but the answer is lost: the replay stops.
    server.losses.push(true);
    await setOffline(false);
    await expect.waitForSteps(["create Repeat Prospect (answer lost)"]);
    await animationFrame();
    expect(prospects()).toEqual([["Alice", 10]]);
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([aliceEntry, bobEntry]);

    // Alice's create is answered with her lead. Bob's create is sent next, and its
    // request is lost before it reaches the server: it stays queued, and is not
    // taken for Alice's lead.
    server.losses.push(null, false);
    await setOffline(false);
    await runAllTimers();
    await expect.waitForSteps([
        "create Repeat Prospect (delivered)",
        "create Repeat Prospect (request lost)",
    ]);
    await animationFrame();
    expect(prospects()).toEqual([["Alice", 10]]);
    expect(queued("crm.lead").map(({ key }) => key)).toEqual([bobEntry]);
    expect(queued("crm.lead")[0].value.extras.error).toBe(undefined);

    // Reconnected, Bob's create makes his own lead: the user gets both leads.
    await reconnect(setOffline);
    await expect.waitForSteps(["create Repeat Prospect"]);
    expect(prospects().sort()).toEqual([
        ["Alice", 10],
        ["Bob", 20],
    ]);
    expect(queued("crm.lead")).toEqual([]);
    expect(await storedQueueKeys(plugin)).toEqual([]);
    expect(server.received.map(({ kwargs }) => kwargs.context[CRM_OFFLINE_CREATE_KEY])).toEqual([
        aliceKey,
        aliceKey,
        bobKey,
    ]);
    expect(server.received[1]).toEqual(server.received[0]);
    expect.verifySteps([]);
});

// -----------------------------------------------------------------------------
// Queue identity: the offline store is shared by every session of the browser
// -----------------------------------------------------------------------------

/** The identity a CRM call is queued with: the session's user and database. */
function sessionOrigin() {
    return { uid: serverState.userId, db: session.db };
}

test("[Offline] CRM calls are queued with the identity of the session queuing them", async () => {
    const rejection = rejectReplay("crm.lead", "web_save", "Save refused");
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    const plugin = getService(OfflinePlugin);
    await setOffline(true);

    // A framework save (the card stage move): the identity is in its extras, in
    // memory and in the offline store, and the call is the one the framework
    // queues, with the id of the user queuing it in its context.
    await moveLeadCard("Lead 1", STAGE_QUALIFIED, 1);
    const [move] = queued("crm.lead");
    expect(move.value.extras.crmOrigin).toEqual(sessionOrigin());
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_QUALIFIED }],
            kwargs: {
                context: queuedContext(PIPELINE_ACTION.context, { default_stage_id: STAGE_NEW }),
                specification: {},
            },
        },
    ]);
    expect(await storedQueueValue(plugin, move.key)).toEqual(
        JSON.parse(JSON.stringify(move.value))
    );

    // Every model the CRM replay sends carries both, and no other model; the
    // caller's kwargs and options are left as they were.
    const options = { extras: { displayName: "Direct", timeStamp: Date.now() } };
    const given = JSON.parse(JSON.stringify(options));
    const kwargs = { context: { lang: "en" }, specification: {} };
    const givenKwargs = JSON.parse(JSON.stringify(kwargs));
    const save = (model, args) => plugin.scheduleORM(model, "web_save", args, kwargs, options);
    const keys = {
        "crm.stage": save("crm.stage", [[STAGE_NEW], {}]),
        "crm.team": save("crm.team", [[1], { color: 3 }]),
        "mail.activity": plugin.scheduleORM("mail.activity", "action_done", [[1]], {}, options),
        "res.partner": save("res.partner", [[1], {}]),
    };
    expect(options).toEqual(given);
    expect(kwargs).toEqual(givenKwargs);
    for (const model of ["crm.stage", "crm.team", "mail.activity"]) {
        expect(plugin._ormToSync()[keys[model]].value.extras).toEqual({
            ...given.extras,
            crmOrigin: sessionOrigin(),
        });
    }
    for (const model of ["crm.stage", "crm.team"]) {
        expect(plugin._ormToSync()[keys[model]].value.kwargs).toEqual({
            context: { lang: "en", [CRM_OFFLINE_UID_KEY]: serverState.userId },
            specification: {},
        });
    }
    expect(plugin._ormToSync()[keys["mail.activity"]].value.kwargs).toEqual({
        context: { [CRM_OFFLINE_UID_KEY]: serverState.userId },
    });
    expect(plugin._ormToSync()[keys["res.partner"]].value.extras).toEqual(given.extras);
    expect(plugin._ormToSync()[keys["res.partner"]].value.kwargs).toEqual(givenKwargs);
    // Extras and a context already naming an identity keep it.
    const otherUid = serverState.userId + 100;
    const otherOrigin = { uid: otherUid, db: session.db };
    const otherKwargs = { context: { [CRM_OFFLINE_UID_KEY]: otherUid }, specification: {} };
    const kept = plugin.scheduleORM("crm.lead", "web_save", [[2], {}], otherKwargs, {
        extras: { crmOrigin: otherOrigin, timeStamp: Date.now() },
    });
    expect(plugin._ormToSync()[kept].value.extras.crmOrigin).toEqual(otherOrigin);
    expect(plugin._ormToSync()[kept].value.kwargs).toEqual({
        context: { [CRM_OFFLINE_UID_KEY]: otherUid },
        specification: {},
    });
    for (const key of [...Object.values(keys), kept]) {
        plugin.removeScheduledORM(key);
    }

    // A refused replay is sent with the id of the user who queued it, and is
    // parked under its key with its first identity and that id.
    stepCalls("crm.lead", "web_save");
    rejection.reject = true;
    await reconnect(setOffline);
    expectParked("crm.lead", "Save refused");
    expect.verifySteps([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_QUALIFIED }],
            kwargs: {
                context: queuedContext(PIPELINE_ACTION.context, { default_stage_id: STAGE_NEW }),
                specification: {},
            },
        },
    ]);
    const [parked] = queued("crm.lead");
    expect(parked.key).toBe(move.key);
    expect(parked.value.extras.crmOrigin).toEqual(sessionOrigin());
    expect(parked.value.kwargs).toEqual(move.value.kwargs);
    const stored = await storedQueueValue(plugin, move.key);
    expect(stored.extras.crmOrigin).toEqual(sessionOrigin());
    expect(stored.kwargs.context[CRM_OFFLINE_UID_KEY]).toBe(serverState.userId);
});

/** JSON-RPC error name of the server's `CrmOfflineOriginError`. */
const ORIGIN_ERROR_NAME = "odoo.addons.crm.models.crm_lead.CrmOfflineOriginError";
/** Message of the server's `CrmOfflineOriginError`. */
const ORIGIN_ERROR_MESSAGE =
    "This offline change was sent in another user's session and was not applied.";

/** Client action standing for a signed-out web client: it mounts no view. */
class CrmTestSignedOut extends Component {
    static template = xml`<div class="o_crm_test_signed_out"/>`;
    static props = ["*"];
}

/**
 * Signs an identity in on this browser, as a user signing out then another signing
 * in does: the web client leaves its views, its session then belongs to `uid` on
 * `db` (the identity its calls are queued with, and the user its call context
 * names), and that session loads the queue from the offline store every session of
 * the browser shares.
 *
 * @param {number|false} uid `false` for a session without a user
 * @param {string} [db] the test session's database by default
 */
async function switchUser(uid, db = serverState.db) {
    registry.category("actions").add("crm_test_signed_out", CrmTestSignedOut, { force: true });
    await getService("action").doAction("crm_test_signed_out", { clearBreadcrumbs: true });
    patchWithCleanup(user, { userId: uid });
    patchWithCleanup(session, { db });
    await getService(OfflinePlugin)._updateScheduledORMList();
    await animationFrame();
}

/**
 * A queued call as the replay of the current session sends it: the ORM adds the
 * session user's context under the call's own (`callPayload` format).
 *
 * @param {{model: string, method: string, args: any[], kwargs: Object}} value
 */
function replayedCall({ model, method, args, kwargs }) {
    const context = { ...user.context, ...kwargs.context };
    return callPayload({ model, method, args, kwargs: { ...kwargs, context } });
}

/**
 * The offline store's queue table, `{key: stored JSON}`.
 *
 * @param {OfflinePlugin} plugin
 * @returns {Promise<Object<string, string>>}
 */
async function storedQueue(plugin) {
    const entries = await plugin._idb.getAllEntries(OfflinePlugin.ORM_SYNC_TABLE_NAME);
    return Object.fromEntries(entries.map(({ key, value }) => [key, value]));
}

/**
 * Asserts the offline store holds exactly the calls of `keys`, each as `snapshot`
 * holds it, byte for byte.
 *
 * @param {OfflinePlugin} plugin
 * @param {Object<string, string>} snapshot a `storedQueue` result
 * @param {string[]} keys
 */
async function expectStoredAsBefore(plugin, snapshot, keys) {
    const stored = await storedQueue(plugin);
    expect(Object.keys(stored).sort()).toEqual([...keys].sort());
    for (const key of keys) {
        expect(stored[key]).toBe(snapshot[key]);
    }
}

/**
 * Asserts the queue of this session holds exactly the calls of `keys`, each as
 * `snapshot` stores it (its error included, for a parked one).
 *
 * @param {OfflinePlugin} plugin
 * @param {Object<string, string>} snapshot a `storedQueue` result
 * @param {string[]} keys
 */
function expectQueuedAsStored(plugin, snapshot, keys) {
    expect(Object.keys(plugin._ormToSync()).sort()).toEqual([...keys].sort());
    for (const key of keys) {
        expect(plugin._ormToSync()[key]).toEqual({ key, value: JSON.parse(snapshot[key]) });
    }
}

/**
 * Emulates, for the lead saves and activity creates the replay of every tab sends,
 * the server session of the browser: it belongs to `browserSession.uid`, the session
 * user by default, and refuses, as the server does (`_check_offline_queue_origin`,
 * `CrmOfflineOriginError`), such a call whose context names another user under
 * `CRM_OFFLINE_UID_KEY`. Signed out (`false`), it refuses each of them as expired.
 *
 * @returns {{uid: number|false}}
 */
function mockBrowserSession() {
    const browserSession = { uid: serverState.userId };
    const refuse = ({ kwargs }) => {
        if (browserSession.uid === false) {
            throw makeServerError({
                errorName: "odoo.http.session.SessionExpiredException",
                message: "user is not connected",
            });
        }
        const queuedBy = kwargs.context?.[CRM_OFFLINE_UID_KEY];
        if (Number.isInteger(queuedBy) && queuedBy !== browserSession.uid) {
            throw makeServerError({ errorName: ORIGIN_ERROR_NAME, message: ORIGIN_ERROR_MESSAGE });
        }
    };
    onRpc("crm.lead", "web_save", refuse);
    onRpc("mail.activity", "create", refuse);
    return browserSession;
}

/**
 * Queues a lead create as the mobile quick create of "My Pipeline" does offline
 * (`createLead`): the pipeline's call context with a delivery key, and the display
 * values of its provisional card.
 *
 * @param {OfflinePlugin} plugin
 * @param {Object} vals the six quick-create values, in the "New" stage
 * @param {string} deliveryKey
 * @returns {string} its queue key
 */
function queueQuickCreate(plugin, vals, deliveryKey) {
    return plugin.scheduleORM(
        "crm.lead",
        "web_save",
        [[], { ...vals, stage_id: STAGE_NEW }],
        {
            context: {
                ...callContext(PIPELINE_ACTION.context),
                [CRM_OFFLINE_CREATE_KEY]: deliveryKey,
            },
            specification: {},
        },
        {
            extras: {
                actionId: PIPELINE_ACTION.id,
                actionName: PIPELINE_ACTION.name,
                viewType: "kanban",
                displayName: vals.name,
                timeStamp: Date.now() + 1,
                changes: { ...vals, stage_id: { id: STAGE_NEW, display_name: "New" } },
            },
        }
    );
}

/**
 * Queues an activity create of a pipeline lead as the mobile activity sheet does
 * (`scheduleActivity`): the session user's context with a new delivery key
 * (`CRM_OFFLINE_CREATE_KEY`, 32 lowercase hex digits) and the pipeline's extras.
 *
 * @param {OfflinePlugin} plugin
 * @param {number} resId the lead
 * @param {string} summary
 * @param {number} userId the assignee
 * @returns {string} its queue key
 */
function queueLeadActivity(plugin, resId, summary, userId) {
    const deliveryKey = [...crypto.getRandomValues(new Uint8Array(16))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    return plugin.scheduleORM(
        "mail.activity",
        "create",
        [
            [
                {
                    res_model: "crm.lead",
                    res_id: resId,
                    activity_type_id: CALL_ACTIVITY_TYPE_ID,
                    summary,
                    date_deadline: "2019-01-01",
                    user_id: userId,
                },
            ],
        ],
        { context: { ...user.context, [CRM_OFFLINE_CREATE_KEY]: deliveryKey } },
        {
            extras: {
                actionId: PIPELINE_ACTION.id,
                actionName: PIPELINE_ACTION.name,
                viewType: "kanban",
                displayName: `Lead ${resId}`,
                timeStamp: Date.now() + 1,
            },
        }
    );
}

/**
 * Queues a contact rename as a partner form saves it offline: the session user's
 * context, and the change with the value it replaces.
 *
 * @param {OfflinePlugin} plugin
 * @param {number} partnerId
 * @returns {string} its queue key
 */
function queuePartnerRename(plugin, partnerId) {
    return plugin.scheduleORM(
        "res.partner",
        "web_save",
        [[partnerId], { name: "Partner renamed" }],
        { context: user.context, specification: {} },
        {
            extras: {
                displayName: "Partner",
                timeStamp: Date.now() + 1,
                changes: { name: "Partner renamed" },
                originalValues: { name: "Partner" },
            },
        }
    );
}

/**
 * Queues a lead rename as the lead form of "My Pipeline" saves it offline: the
 * pipeline's call context, and the change with the value it replaces.
 *
 * @param {OfflinePlugin} plugin
 * @param {number} resId
 * @param {string} name
 * @returns {string} its queue key
 */
function queueLeadRename(plugin, resId, name) {
    return plugin.scheduleORM(
        "crm.lead",
        "web_save",
        [[resId], { name }],
        { context: callContext(PIPELINE_ACTION.context), specification: {} },
        {
            extras: {
                actionId: PIPELINE_ACTION.id,
                actionName: PIPELINE_ACTION.name,
                viewType: "form",
                displayName: name,
                timeStamp: Date.now() + 1,
                changes: { name },
                originalValues: { name: `Lead ${resId}` },
            },
        }
    );
}

test("[Offline] CRM calls another user queued in this browser are neither shown, replayed nor removed", async () => {
    // Offline root load served from the cache: this user's pipeline, opened again.
    expect.errors(1);
    stepCalls("crm.lead", "web_save");
    stepCalls("mail.activity", "create");
    stepCalls("res.partner", "web_save");
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    const plugin = getService(OfflinePlugin);
    const { env } = MockServer;
    const partnerId = env["res.partner"].create({ name: "Partner" });
    const ownUid = serverState.userId;
    const otherUid = ownUid + 100;
    const otherDb = `${serverState.db}_other`;

    // This user moves a lead offline, and signs out with the move still queued.
    await setOffline(true);
    await moveLeadCard("Lead 2", STAGE_QUALIFIED, 1);
    const [ownMove] = queued("crm.lead");
    expect(ownMove.value.extras.crmOrigin).toEqual(sessionOrigin());

    // Another user signs in on this browser: their session loads the store without
    // this user's move, and their replay sends nothing when the connection returns.
    await switchUser(otherUid);
    expect(plugin._ormToSync()).toEqual({});
    await reconnect(setOffline);
    expect(plugin.syncingORM()).toBe(false);
    expect(await storedQueueKeys(plugin)).toEqual([ownMove.key]);
    expect.verifySteps([]);

    // They visit their pipeline and a lead online. Offline, they rename the lead and
    // change its revenue in its form, quick-create a lead, schedule an activity on
    // another lead and rename a contact.
    await getService("action").doAction(PIPELINE_ACTION.id, { clearBreadcrumbs: true });
    await openLead(1);
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Foreign Pending");
    await contains(".o_field_widget[name=expected_revenue] input").edit("1777");
    await contains(".o_form_button_save").click();
    const [foreignEdit] = queued("crm.lead");
    expect(foreignEdit.value.args[0]).toEqual([1]);
    expect(foreignEdit.value.args[1]).toMatchObject({
        name: "Foreign Pending",
        expected_revenue: 1777,
    });
    const foreignCreate = queueQuickCreate(
        plugin,
        {
            name: "Foreign Create",
            contact_name: "Foreign contact",
            phone: "",
            email_from: "",
            expected_revenue: 2777,
        },
        "0123456789abcdef".repeat(2)
    );
    const foreignActivity = queueLeadActivity(plugin, 2, "Foreign call", otherUid);
    const partnerRename = queuePartnerRename(plugin, partnerId);

    // This user, signed in on another database served on this browser's origin,
    // renames a lead there.
    await switchUser(ownUid, otherDb);
    expect(Object.keys(plugin._ormToSync())).toEqual([partnerRename]);
    const otherDatabaseEdit = queueLeadRename(plugin, 3, "Other database");

    // Each CRM call carries the identity of the session that queued it.
    const snapshot = await storedQueue(plugin);
    const foreignKeys = [foreignEdit.key, foreignCreate, foreignActivity, otherDatabaseEdit];
    expect(Object.keys(snapshot).sort()).toEqual(
        [ownMove.key, partnerRename, ...foreignKeys].sort()
    );
    for (const key of [foreignEdit.key, foreignCreate, foreignActivity]) {
        const { extras, kwargs } = JSON.parse(snapshot[key]);
        expect(extras.crmOrigin).toEqual({ uid: otherUid, db: serverState.db });
        expect(kwargs.context.uid).toBe(otherUid);
        expect(kwargs.context[CRM_OFFLINE_UID_KEY]).toBe(otherUid);
    }
    expect(JSON.parse(snapshot[otherDatabaseEdit]).extras.crmOrigin).toEqual({
        uid: ownUid,
        db: otherDb,
    });

    // This user signs in on this database again: their session loads their own move
    // and the contact rename (calls of other apps are the framework's), and none of
    // the other identities' CRM calls. Their pipeline opens from the cache.
    await switchUser(ownUid);
    expectQueuedAsStored(plugin, snapshot, [ownMove.key, partnerRename]);
    await getService("action").doAction(PIPELINE_ACTION.id, { clearBreadcrumbs: true });
    expect.verifyErrors([LEAD_GROUPS_LOAD]);

    // Neither the pipeline nor the activity sheet shows them; this user's own move
    // shows as pending. The desktop kanban shows the leads as loaded.
    for (const name of ["Foreign Pending", "Foreign Create", "Other database"]) {
        expect(pipelineLeadNames()).not.toInclude(name);
    }
    if (isSmall()) {
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("New");
        expect(pipelineLeadNames().sort()).toEqual(["Lead 1", "Lead 3"]);
        expect(".o_crm_mobile_pipeline_count").toHaveText("2");
        expect(".o_crm_mobile_lead_card_provisional").toHaveCount(0);
        for (const name of ["Lead 1", "Lead 3"]) {
            expect(`${await revealLeadCard(name)} .o_crm_mobile_pending_sync`).toHaveCount(0);
        }
        const ownCard = await revealLeadCard("Lead 2");
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("Qualified");
        expect(`${ownCard} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");
        await contains(`${ownCard} .o_crm_mobile_lead_activities_button`).click();
        expect(".o_bottom_sheet .o_crm_mobile_lead_activities_sheet").toHaveCount(1);
        expect(".o_crm_mobile_lead_activities_sheet:contains(Foreign call)").toHaveCount(0);
        expect(".o_crm_mobile_activity_pending").toHaveCount(0);
        await contains(".o_bottom_sheet_backdrop").click();
        await animationFrame();
        expect(".o_bottom_sheet").toHaveCount(0);
    }

    // The systray lists this session's calls only.
    await openSystray();
    expect(
        queryAllTexts(".o_offline_systray_content .o-dropdown-item .text-truncate").sort()
    ).toEqual(["Lead 2", "Partner"]);
    await press("Escape");
    await animationFrame();

    // Reconnected, the replay sends this session's calls, in order and verbatim, and
    // none of the other identities' CRM calls, which stay in the store unchanged.
    await reconnect(setOffline);
    await expect.waitForSteps([
        replayedCall(ownMove.value),
        replayedCall(JSON.parse(snapshot[partnerRename])),
    ]);
    await animationFrame();
    expect(plugin.syncingORM()).toBe(false);
    expect(plugin._ormToSync()).toEqual({});
    expect(env["crm.lead"].browse(2)[0].stage_id).toBe(STAGE_QUALIFIED);
    expect(env["crm.lead"].browse(1)[0].name).toBe("Lead 1");
    expect(env["crm.lead"].browse(1)[0].expected_revenue).toBe(5);
    expect(env["crm.lead"].browse(3)[0].name).toBe("Lead 3");
    expect(env["crm.lead"].search_count([["name", "=", "Foreign Create"]])).toBe(0);
    expect(env["mail.activity"].search_count([["summary", "=", "Foreign call"]])).toBe(0);
    expect(env["res.partner"].browse(partnerId)[0].name).toBe("Partner renamed");
    await expectStoredAsBefore(plugin, snapshot, foreignKeys);

    // The session of each identity loads its own calls, as stored, which the mobile
    // pipeline of their user shows; a session without a user owns none.
    await switchUser(otherUid);
    expectQueuedAsStored(plugin, snapshot, [foreignEdit.key, foreignCreate, foreignActivity]);
    if (isSmall()) {
        await getService("action").doAction(PIPELINE_ACTION.id, { clearBreadcrumbs: true });
        const foreignCard = await revealLeadCard("Foreign Pending");
        expect(`${foreignCard} .o_crm_mobile_pending_sync`).toHaveText("Pending sync");
        expect(".o_crm_mobile_lead_card_provisional:contains(Foreign Create)").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_count").toHaveText("3");
    }
    await switchUser(ownUid, otherDb);
    expectQueuedAsStored(plugin, snapshot, [otherDatabaseEdit]);
    await switchUser(false);
    expect(plugin._ormToSync()).toEqual({});
    await expectStoredAsBefore(plugin, snapshot, foreignKeys);
    expect.verifySteps([]);
});

test("[Offline] an own CRM call refused in another user's session stays parked with Sync failed in its owner's session and can be discarded", async () => {
    // Offline root load served from the cache: the pipeline, back from the lead form.
    expect.errors(1);
    const browserSession = mockBrowserSession();
    const moveRejection = rejectReplay("crm.lead", "web_save", "Move refused");
    const renameRejection = rejectReplay("res.partner", "web_save", "Rename refused");
    // Registered after the refusals, so they run first: every call reaching the mock
    // server is stepped, the refused ones included.
    stepCalls("crm.lead", "web_save");
    stepCalls("mail.activity", "create");
    stepCalls("res.partner", "web_save");
    const setOffline = mockOffline();
    await openPipeline();
    await flushStartupSync();
    const plugin = getService(OfflinePlugin);
    const { env } = MockServer;
    const partnerId = env["res.partner"].create({ name: "Partner" });
    const ownUid = serverState.userId;
    const otherUid = ownUid + 100;
    const originError = `${ORIGIN_ERROR_NAME} - ${ORIGIN_ERROR_MESSAGE}`;
    /** Keys of the queued lead calls of the lead `resId`. */
    const leadKeys = (resId) =>
        Object.values(plugin._ormToSync())
            .filter(({ value }) => value.model === "crm.lead" && value.args[0][0] === resId)
            .map(({ key }) => key);

    // This user's calls are parked by native replays the server refuses. A lead move
    // is sent while the browser's session is signed out.
    await setOffline(true);
    await moveLeadCard("Lead 4", STAGE_NEW, 0);
    const [signedOutMove] = queued("crm.lead");
    browserSession.uid = false;
    await reconnect(setOffline);
    await expect.waitForSteps([replayedCall(signedOutMove.value)]);
    browserSession.uid = ownUid;

    // A lead move and a contact rename are refused for another reason.
    await setOffline(true);
    await moveLeadCard("Lead 2", STAGE_QUALIFIED, 1);
    const [refusedMove] = leadKeys(2);
    const partnerRename = queuePartnerRename(plugin, partnerId);
    const refusedCalls = [refusedMove, partnerRename].map((key) =>
        replayedCall(plugin._ormToSync()[key].value)
    );
    moveRejection.reject = true;
    renameRejection.reject = true;
    await reconnect(setOffline);
    await expect.waitForSteps(refusedCalls);
    moveRejection.reject = false;
    renameRejection.reject = false;

    // A lead edit saved in its form and an activity scheduled on another lead are
    // sent from this user's tab once another user has signed in on the browser: the
    // server refuses them as sent in another user's session.
    await openLead(1);
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 1 renamed");
    await contains(".o_form_button_save").click();
    await goBack();
    expect.verifyErrors([LEAD_GROUPS_LOAD]);
    const [ownEdit] = leadKeys(1);
    const ownActivity = queueLeadActivity(plugin, 3, "Own call", ownUid);
    const elsewhereCalls = [ownEdit, ownActivity].map((key) =>
        replayedCall(plugin._ormToSync()[key].value)
    );
    browserSession.uid = otherUid;
    await reconnect(setOffline);
    await expect.waitForSteps(elsewhereCalls);
    // Parked as any refused replay: no dialog opens.
    expect(".modal").toHaveCount(0);

    // The other user's tab, once this user has signed in again: its lead edit is
    // refused the same way.
    browserSession.uid = ownUid;
    await switchUser(otherUid);
    await setOffline(true);
    const foreignEdit = queueLeadRename(plugin, 1, "Foreign Refused");
    const foreignCall = replayedCall(plugin._ormToSync()[foreignEdit].value);
    await reconnect(setOffline);
    await expect.waitForSteps([foreignCall]);
    expect(plugin._ormToSync()[foreignEdit].value.extras.error).toBe(originError);

    // Each refused call is parked in the store with the server's error.
    const snapshot = await storedQueue(plugin);
    const parkedErrors = {
        [signedOutMove.key]: "odoo.http.session.SessionExpiredException - user is not connected",
        [refusedMove]: "odoo.exceptions.UserError - Move refused",
        [partnerRename]: "odoo.exceptions.UserError - Rename refused",
        [ownEdit]: originError,
        [ownActivity]: originError,
        [foreignEdit]: originError,
    };
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(parkedErrors).sort());
    for (const [key, error] of Object.entries(parkedErrors)) {
        expect(JSON.parse(snapshot[key]).extras.error).toBe(error);
    }
    const ownKeys = [signedOutMove.key, refusedMove, ownEdit, ownActivity];

    // This user signs in again: their session loads each of their calls as stored,
    // parked with its error, with the contact rename and without the other user's
    // call.
    await switchUser(ownUid);
    expectQueuedAsStored(plugin, snapshot, [...ownKeys, partnerRename]);
    await getService("action").doAction(PIPELINE_ACTION.id, { clearBreadcrumbs: true });

    // The pipeline shows the leads of the parked calls, and the activity, as failed,
    // and nothing of the other user's call.
    expect(pipelineLeadNames()).not.toInclude("Foreign Refused");
    if (isSmall()) {
        for (const name of ["Lead 1 renamed", "Lead 2", "Lead 4"]) {
            const card = await revealLeadCard(name);
            expect(`${card} .o_crm_mobile_pending_sync`).toHaveText("Sync failed");
            expect(`${card} .o_crm_mobile_pending_sync`).toHaveClass("text-bg-danger");
        }
        const card = await revealLeadCard("Lead 3");
        await contains(`${card} .o_crm_mobile_lead_activities_button`).click();
        const row = ".o_crm_mobile_activity_pending:contains(Own call)";
        expect(`${row} .o_crm_mobile_pending_sync`).toHaveText("Sync failed");
        expect(`${row} .o_crm_mobile_pending_sync`).toHaveClass("text-bg-danger");
        await contains(".o_bottom_sheet_backdrop").click();
        await animationFrame();
        expect(".o_bottom_sheet").toHaveCount(0);
    }

    // The systray lists every call of this session in error, with the server's
    // message: for the edit and the activity, that it was sent in another user's
    // session and not applied.
    await openSystray();
    const systrayItem = (name) =>
        `.o_offline_systray_content .o-dropdown-item:contains(${name}) div.text-truncate`;
    expect(
        queryAllTexts(".o_offline_systray_content .o-dropdown-item div.text-danger").sort()
    ).toEqual(["Lead 1 renamed", "Lead 2", "Lead 3", "Lead 4", "Partner"]);
    expect(systrayItem("Lead 1 renamed")).toHaveAttribute("data-tooltip", ORIGIN_ERROR_MESSAGE);
    expect(systrayItem("Lead 3")).toHaveAttribute("data-tooltip", ORIGIN_ERROR_MESSAGE);
    await press("Escape");
    await animationFrame();

    // Reconnected, the replay sends none of them, nor does the next one after a new
    // load of the queue: they stay queued and stored as they were.
    await setOffline(true);
    await reconnect(setOffline);
    expect(plugin.syncingORM()).toBe(false);
    expectQueuedAsStored(plugin, snapshot, [...ownKeys, partnerRename]);
    await plugin._updateScheduledORMList();
    await setOffline(true);
    await reconnect(setOffline);
    expectQueuedAsStored(plugin, snapshot, [...ownKeys, partnerRename]);
    await expectStoredAsBefore(plugin, snapshot, Object.keys(parkedErrors));
    expect.verifySteps([]);
    expect(env["crm.lead"].browse(1)[0].name).toBe("Lead 1");
    expect(env["mail.activity"].search_count([["summary", "=", "Own call"]])).toBe(0);

    // Discarded from the systray, the edit and the activity leave the queue and the
    // store: the lead shows its server values, and the sheet no longer lists the
    // activity. The other calls stay parked as they were.
    await discardFromSystray("Lead 1 renamed");
    if (queryFirst(".o_offline_systray_content")) {
        await press("Escape");
        await animationFrame();
    }
    await discardFromSystray("Lead 3");
    await animationFrame();
    const kept = [signedOutMove.key, refusedMove, partnerRename];
    expectQueuedAsStored(plugin, snapshot, kept);
    await expectStoredAsBefore(plugin, snapshot, [...kept, foreignEdit]);
    if (isSmall()) {
        const card = await revealLeadCard("Lead 1");
        expect(pipelineLeadNames()).not.toInclude("Lead 1 renamed");
        expect(`${card} .o_crm_mobile_pending_sync`).toHaveCount(0);
        await contains(
            `${await revealLeadCard("Lead 3")} .o_crm_mobile_lead_activities_button`
        ).click();
        expect(".o_crm_mobile_lead_activities_sheet:contains(Own call)").toHaveCount(0);
        await contains(".o_bottom_sheet_backdrop").click();
        await animationFrame();
    }

    // The other user's session loads that user's call, parked as stored, with the
    // contact rename, and none of this user's calls.
    await switchUser(otherUid);
    expectQueuedAsStored(plugin, snapshot, [foreignEdit, partnerRename]);
    await expectStoredAsBefore(plugin, snapshot, [...kept, foreignEdit]);
    expect.verifySteps([]);
});

// -----------------------------------------------------------------------------
// Lead form reconciliation: the displayed lead after its queued calls replay or
// are discarded, with the changes the form restored from the queue and the edits
// made since
// -----------------------------------------------------------------------------

/** The "Won" button of the lead form header. */
const WON_BUTTON = ".o_form_statusbar button[name=action_set_won_rainbowman]";

/** The current stage of the lead form statusbar (inline on desktop, a dropdown on mobile). */
function currentStageSelector() {
    return isSmall() ? ".o_statusbar_status .dropdown-toggle:visible" : ".o_arrow_button_current";
}

/**
 * Captures the lead form controllers set up by the test, the last one first.
 *
 * @returns {CrmFormController[]}
 */
function captureLeadForms() {
    const controllers = [];
    patchWithCleanup(CrmFormController.prototype, {
        setup() {
            super.setup(...arguments);
            controllers.unshift(this);
        },
    });
    return controllers;
}

/** Steps the `crm.lead` `web_read` requests reaching the mock server, with their ids. */
function stepLeadReads() {
    onRpc("crm.lead", "web_read", ({ args }) => {
        expect.step(`web_read ${JSON.stringify(args[0])}`);
    });
}

test("[Offline] reopened lead with a queued probability and won shows 100%", async () => {
    // Offline root loads served from the cache: back to the pipeline, the reopened
    // lead and its reload after the discard.
    expect.errors(3);
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    await setOffline(true);
    await contains(".o_field_widget[name=probability] input").edit("42");
    await contains(".o_form_button_save").click();
    await contains(WON_BUTTON).click();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(".o_field_widget[name=probability]").toHaveText("100.00");
    const context = queuedContext(PIPELINE_ACTION.context);
    const calls = [
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { probability: 42 }],
            kwargs: { context, specification: {} },
        },
        { model: "crm.lead", method: "action_set_won", args: [[1]], kwargs: { context } },
    ];
    expect(queuedCalls("crm.lead")).toEqual(calls);

    // Reopened while both calls wait: the probability restored from the queued save
    // does not hide the won values, and the queue is left as it was.
    await goBack();
    await openLead(1);
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(".o_field_widget[name=probability]").toHaveText("100.00");
    expect(queuedCalls("crm.lead")).toEqual(calls);

    // The won discarded while the save waits: the lead shows the queued probability.
    await openSystray();
    await contains(
        `.o_offline_systray_content .o-dropdown-item:has(.o_badge:contains(Won)) button[title="Discard offline changes"]`
    ).click();
    await contains(".modal-footer .btn-primary").click();
    expect(queuedCalls("crm.lead")).toEqual([calls[0]]);
    expect(".ribbon:contains(Won)").toHaveCount(0);
    expect(".o_field_widget[name=probability] input").toHaveValue("42.00");
    expect.verifyErrors([LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] replay of a reopened lead's queued stage and won resends nothing", async () => {
    // Offline root loads served from the cache: back to the pipeline and the
    // reopened lead, for each of the two leads.
    expect.errors(4);
    stepWebSave();
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    // Stage B then Won, queued offline; the lead is reopened (its queued stage is
    // restored into the form) and renamed without saving.
    await setOffline(true);
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_form_button_save").click();
    await contains(WON_BUTTON).click();
    await goBack();
    await openLead(1);
    await contains(".o_field_widget[name=name] input").edit("Lead 1 renamed");
    expect.verifySteps([]);

    // The replay writes stage B, then the won stage; the reconciliation saves the
    // rename only, never the replayed stage again.
    const context = callContext(PIPELINE_ACTION.context);
    const replayContext = queuedContext(PIPELINE_ACTION.context);
    await reconnect(setOffline);
    await expect.waitForSteps([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_QUALIFIED }],
            kwargs: { context: replayContext, specification: {} },
        },
        {
            model: "crm.lead",
            method: "action_set_won",
            args: [[1]],
            kwargs: { context: replayContext },
        },
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { name: "Lead 1 renamed" }],
            kwargs: { context, specification: leadFormReadBack() },
        },
    ]);
    await animationFrame();
    expect.verifySteps([]);
    expect(MockServer.env["crm.lead"].browse(1)[0]).toMatchObject({
        name: "Lead 1 renamed",
        stage_id: STAGE_WON,
        won_status: "won",
    });
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 renamed");
    expect(currentStageSelector()).toHaveText("Won");

    // Without a later edit, the reconciliation saves nothing after the won.
    await goBack();
    await openLead(2);
    await setOffline(true);
    await selectStage(STAGE_QUALIFIED, "Qualified");
    await contains(".o_form_button_save").click();
    await contains(WON_BUTTON).click();
    await goBack();
    await openLead(2);
    await reconnect(setOffline);
    await expect.waitForSteps([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[2], { stage_id: STAGE_QUALIFIED }],
            kwargs: { context: replayContext, specification: {} },
        },
        {
            model: "crm.lead",
            method: "action_set_won",
            args: [[2]],
            kwargs: { context: replayContext },
        },
    ]);
    await animationFrame();
    expect.verifySteps([]);
    expect(MockServer.env["crm.lead"].browse(2)[0].stage_id).toBe(STAGE_WON);
    expect(currentStageSelector()).toHaveText("Won");
    expect(queued("crm.lead")).toEqual([]);
    expect.verifyErrors([LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD, LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD]);
});

/**
 * Gives lead 1 a partner whose email and phone differ from the lead's, so a save of
 * the lead also writes its email and phone for the server to synchronize the partner
 * (`partner_email_update` and `partner_phone_update` are set). The mock server
 * computes neither flag, so its `web_save` of the lead does what the server does: a
 * written email or phone is copied to the partner, which then needs no
 * synchronization (the flag turns false). The lead's `web_save` and `web_read`
 * requests are stepped.
 *
 * @returns {Promise<{env: Object, partnerId: number}>}
 */
async function setupLeadWithPartnerToSynchronize() {
    const { env } = await makeMockServer();
    const partnerId = env["res.partner"].create({
        name: "Partner to synchronize",
        email: "partner@example.com",
        phone: "+32 470 00 00 00",
    });
    env["crm.lead"].write([1], {
        partner_id: partnerId,
        email_from: "old@example.com",
        phone: "+32 470 11 11 11",
        partner_email_update: true,
        partner_phone_update: true,
    });
    onRpc("crm.lead", "web_save", ({ args: [ids, vals] }) => {
        expect.step(`web_save ${JSON.stringify([ids, vals])}`);
        const partnerValues = {};
        const leadValues = {};
        if ("email_from" in vals) {
            partnerValues.email = vals.email_from;
            leadValues.partner_email_update = false;
        }
        if ("phone" in vals) {
            partnerValues.phone = vals.phone;
            leadValues.partner_phone_update = false;
        }
        if (Object.keys(leadValues).length) {
            env["res.partner"].write([partnerId], partnerValues);
            env["crm.lead"].write(ids, leadValues);
        }
    });
    stepLeadReads();
    return { env, partnerId };
}

/**
 * From the lead form of lead 1 (opened online by the test), saves an email and a
 * phone offline, reopens the lead (both are restored into the form from the queued
 * save) and renames it without saving.
 *
 * @param {(offline: boolean) => Promise<void>} setOffline
 */
async function queueContactsThenRenameReopenedLead(setOffline) {
    await setOffline(true);
    await contains(".o_field_widget[name=email_from] input").edit("replayed@example.com");
    await contains(".o_field_widget[name=phone] input").edit("+32 470 22 22 22");
    await contains(".o_form_button_save").click();
    await goBack();
    await openLead(1);
    expect(".o_field_widget[name=email_from] input").toHaveValue("replayed@example.com");
    expect(".o_field_widget[name=phone] input").toHaveValue("+32 470 22 22 22");
    await contains(".o_field_widget[name=name] input").edit("Genuine later edit");
}

test("[Offline] replay reconciliation does not resend stale forced email and phone", async () => {
    // Offline root loads served from the cache: back to the pipeline and the
    // reopened lead.
    expect.errors(2);
    const { env, partnerId } = await setupLeadWithPartnerToSynchronize();
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();
    expect.verifySteps(["web_read [1]"]);
    await queueContactsThenRenameReopenedLead(setOffline);
    expect.verifySteps([]);

    // The replay writes the email and phone, which the server copies to the partner.
    // The reconciliation then reads the lead and saves the rename only: the email
    // and phone it read need no synchronization, and those the lead had before the
    // replay are never sent.
    await reconnect(setOffline);
    await runAllTimers();
    await animationFrame();
    expect.verifySteps([
        `web_save [[1],{"email_from":"replayed@example.com","phone":"+32 470 22 22 22"}]`,
        "web_read [1]",
        `web_save [[1],{"name":"Genuine later edit"}]`,
    ]);
    expect(env["crm.lead"].browse(1)[0]).toMatchObject({
        name: "Genuine later edit",
        email_from: "replayed@example.com",
        phone: "+32 470 22 22 22",
    });
    expect(env["res.partner"].browse(partnerId)[0]).toMatchObject({
        email: "replayed@example.com",
        phone: "+32 470 22 22 22",
    });
    expect(".o_field_widget[name=name] input").toHaveValue("Genuine later edit");
    expect(".o_field_widget[name=email_from] input").toHaveValue("replayed@example.com");
    expect(".o_field_widget[name=phone] input").toHaveValue("+32 470 22 22 22");
    expect(queued("crm.lead")).toEqual([]);
    expect.verifyErrors([LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] replay reconciliation force-saves the email and phone the server holds", async () => {
    // Offline root loads served from the cache: back to the pipeline and the
    // reopened lead.
    expect.errors(2);
    const { env, partnerId } = await setupLeadWithPartnerToSynchronize();
    // Once the replay is done, the lead's email and phone change on the server and
    // differ from its partner's: both flags are set when the reconciliation reads
    // the lead (written here, as the mock server computes neither).
    let changeOnServer = false;
    onRpc("crm.lead", "web_read", () => {
        if (changeOnServer) {
            changeOnServer = false;
            env["crm.lead"].write([1], {
                email_from: "server@example.com",
                phone: "+32 470 33 33 33",
                partner_email_update: true,
                partner_phone_update: true,
            });
        }
    });
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();
    expect.verifySteps(["web_read [1]"]);
    await queueContactsThenRenameReopenedLead(setOffline);
    expect.verifySteps([]);

    // The reconciliation save of the rename synchronizes the partner the way every
    // lead save does, with the email and phone the lead holds on the server now:
    // neither the replayed nor the pre-replay values.
    changeOnServer = true;
    await reconnect(setOffline);
    await runAllTimers();
    await animationFrame();
    expect(changeOnServer).toBe(false);
    expect.verifySteps([
        `web_save [[1],{"email_from":"replayed@example.com","phone":"+32 470 22 22 22"}]`,
        "web_read [1]",
        `web_save [[1],{"name":"Genuine later edit","email_from":"server@example.com","phone":"+32 470 33 33 33"}]`,
    ]);
    expect(env["crm.lead"].browse(1)[0]).toMatchObject({
        name: "Genuine later edit",
        email_from: "server@example.com",
        phone: "+32 470 33 33 33",
        partner_email_update: false,
        partner_phone_update: false,
    });
    expect(env["res.partner"].browse(partnerId)[0]).toMatchObject({
        email: "server@example.com",
        phone: "+32 470 33 33 33",
    });
    expect(".o_field_widget[name=email_from] input").toHaveValue("server@example.com");
    expect(".o_field_widget[name=phone] input").toHaveValue("+32 470 33 33 33");
    expect(queued("crm.lead")).toEqual([]);
    expect.verifyErrors([LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] lead form reconciles the displayed lead only, across the pager", async () => {
    let rejectLead1 = false;
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (rejectLead1 && args[0][0] === 1) {
            throw makeServerError({ message: "Lead 1 refused" });
        }
        expect.step(`web_save ${JSON.stringify(args[0])}`);
    });
    stepLeadReads();
    const setOffline = mockOffline();
    await openPipeline();
    await getService("action").switchView("form", { resId: 1, resIds: [1, 2] });
    await animationFrame();
    await flushStartupSync();
    expect.verifySteps(["web_read [1]"]);

    // Lead A: an offline save whose replay is rejected stays parked.
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 1 parked");
    await contains(".o_form_button_save").click();
    rejectLead1 = true;
    await reconnect(setOffline);
    expectParked("crm.lead", "Lead 1 refused");
    expect.verifySteps([]);

    // Lead B, through the pager: its replayed save reconciles it with the server
    // values, even though the write of A stays parked.
    await contains(".o_pager_next").click();
    expect.verifySteps(["web_read [2]"]);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 2");
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 2 offline");
    await contains(".o_form_button_save").click();
    await reconnect(setOffline);
    await expect.waitForSteps(["web_save [2]", "web_read [2]"]);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 2 offline");

    // Discarding the parked write of A neither reloads B nor drops its unsaved edit.
    await contains(".o_field_widget[name=name] input").edit("Lead 2 unsaved");
    await discardFromSystray("Lead 1 parked");
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 2 unsaved");
    expect.verifySteps([]);
    await contains(".o_form_button_save").click();
    expect.verifySteps(["web_save [2]"]);
    expect(MockServer.env["crm.lead"].browse(2)[0].name).toBe("Lead 2 unsaved");
    expect(MockServer.env["crm.lead"].browse(1)[0].name).toBe("Lead 1");
});

test("[Offline] edits made while the replay reconciliation loads are kept", async () => {
    stepWebSave();
    let heldRead = null;
    onRpc("crm.lead", "web_read", () => heldRead?.promise);
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 1 offline");
    await contains(".o_form_button_save").click();

    // The replay ends; the reconciliation read is held while the phone is edited.
    heldRead = Promise.withResolvers();
    const { resolve } = heldRead;
    const context = callContext(PIPELINE_ACTION.context);
    await reconnect(setOffline);
    await expect.waitForSteps([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { name: "Lead 1 offline" }],
            kwargs: { context: queuedContext(PIPELINE_ACTION.context), specification: {} },
        },
    ]);
    await contains(".o_field_widget[name=phone] input").edit("+32 470 12 34 56");
    heldRead = null;
    resolve();
    await animationFrame();
    await animationFrame();

    // The lead shows the server values and keeps the edit, which a save writes.
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 offline");
    expect(".o_field_widget[name=phone] input").toHaveValue("+32 470 12 34 56");
    await contains(".o_form_button_save").click();
    await expect.waitForSteps([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { phone: "+32 470 12 34 56" }],
            kwargs: { context, specification: leadFormReadBack() },
        },
    ]);
    expect(MockServer.env["crm.lead"].browse(1)[0]).toMatchObject({
        name: "Lead 1 offline",
        phone: "+32 470 12 34 56",
    });
});

test("[Offline] refresh requests of the lead form waiting to start are merged", async () => {
    const controllers = captureLeadForms();
    stepLeadReads();
    await openPipeline();
    await openLead(1);
    expect.verifySteps(["web_read [1]"]);
    const root = controllers[0].model.root;

    // Two requests made before the first one starts: one refresh, one read.
    const first = root.crmRefresh();
    const second = root.crmRefresh({ dropRestored: true });
    expect(second).toBe(first);
    await first;
    expect.verifySteps(["web_read [1]"]);

    // A request made once the previous one has run is a refresh of its own.
    await root.crmRefresh();
    expect.verifySteps(["web_read [1]"]);
});

test("[Offline] discarding a reopened lead's queued save keeps the later edits only", async () => {
    // Offline root loads served from the cache: back to the pipeline, the reopened
    // lead and its reload after the discard.
    expect.errors(3);
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    // A queued save of the name; the lead is reopened (the name is restored into the
    // form) and its phone edited without saving.
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 1 queued");
    await contains(".o_form_button_save").click();
    await goBack();
    await openLead(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 queued");
    await contains(".o_field_widget[name=phone] input").edit("+32 470 55 55 55");

    // The discard reverts the restored name and keeps the phone edit...
    await discardFromSystray("Lead 1 queued");
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1");
    expect(".o_field_widget[name=phone] input").toHaveValue("+32 470 55 55 55");

    // ... and a later save queues the phone only, never the discarded name.
    await contains(".o_form_button_save").click();
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { phone: "+32 470 55 55 55" }],
            kwargs: { context: queuedContext(PIPELINE_ACTION.context), specification: {} },
        },
    ]);
    expect.verifyErrors([LEAD_GROUPS_LOAD, LEAD_RECORD_LOAD, LEAD_RECORD_LOAD]);
});

test("[Offline] a failed reconciliation is reported once, a lost connection is not", async () => {
    // Exactly the two server errors below: the lost connection reports nothing.
    expect.errors(2);
    let failNext = null;
    onRpc("crm.lead", "web_read", () => {
        if (failNext === "read") {
            failNext = null;
            throw makeServerError({ message: "Lead read failed" });
        }
    });
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (failNext === "save" && args[1].phone) {
            failNext = null;
            throw makeServerError({ message: "Lead save failed" });
        }
    });
    const setOffline = mockOffline();
    // A lost connection on the reconciliation read only (a 502 answer, as offline).
    let dropRead = false;
    onRpc("/*", (request) => {
        if (dropRead && new URL(request.url).pathname === LEAD_RECORD_LOAD) {
            dropRead = false;
            return new Response("", { status: 502 });
        }
    });
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    /** Saves a new name offline and reconnects, which replays it and reconciles. */
    async function saveOfflineAndReplay(name) {
        await setOffline(true);
        await contains(".o_field_widget[name=name] input").edit(name);
        await contains(".o_form_button_save").click();
        await reconnect(setOffline);
        await runAllTimers();
        await animationFrame();
    }

    // The reconciliation read fails on the server: reported once.
    failNext = "read";
    await saveOfflineAndReplay("Lead 1 first");
    expect(failNext).toBe(null);
    expect.verifyErrors(["Lead read failed"]);
    expect(MockServer.env["crm.lead"].browse(1)[0].name).toBe("Lead 1 first");

    // The reconciliation read loses the connection: nothing is reported.
    dropRead = true;
    await saveOfflineAndReplay("Lead 1 second");
    expect(dropRead).toBe(false);
    expect.verifyErrors([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].name).toBe("Lead 1 second");
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 second");

    // The reconciliation save of a later edit fails on the server: reported once, and
    // the edit stays in the form.
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 1 third");
    await contains(".o_form_button_save").click();
    await contains(".o_field_widget[name=phone] input").edit("+32 470 00 00 09");
    failNext = "save";
    await reconnect(setOffline);
    await runAllTimers();
    await animationFrame();
    expect(failNext).toBe(null);
    expect.verifyErrors(["Lead save failed"]);
    expect(MockServer.env["crm.lead"].browse(1)[0].name).toBe("Lead 1 third");
    expect(".o_field_widget[name=phone] input").toHaveValue("+32 470 00 00 09");
});

test("[Offline] merged reconciliations report their shared failure once", async () => {
    // The one server error below, shared by two reconciliations.
    expect.errors(1);
    const controllers = captureLeadForms();
    onRpc("crm.lead", "web_save", ({ args }) => {
        if (args[1].phone) {
            throw makeServerError({ message: "Lead save failed" });
        }
    });
    mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();
    const [form] = controllers;

    // Two reconciliations asked for at once (a replay and a reconnection ending in
    // one batch) merge into one refresh, whose save of the kept edit fails: one
    // failure, reported once. Hoot counts one error object once, so the dialog count
    // shows a repeated report.
    await contains(".o_field_widget[name=phone] input").edit("+32 470 00 00 10");
    await Promise.all([
        form.crmOwn(form.crmReconcile({ save: true })),
        form.crmOwn(form.crmReconcile({ save: true })),
    ]);
    await waitFor(".o_error_dialog:contains(Lead save failed)");
    await animationFrame();
    expect(".o_error_dialog").toHaveCount(1);
    expect.verifyErrors(["Lead save failed"]);
    expect(".o_field_widget[name=phone] input").toHaveValue("+32 470 00 00 10");
});

test("[Offline] lead form tracks only the queued calls of the displayed lead", async () => {
    const controllers = captureLeadForms();
    const rejection = rejectReplay("crm.lead", "web_save", "Save refused");
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();
    const [form] = controllers;

    // A parked write of the lead.
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 1 parked");
    await contains(".o_form_button_save").click();
    rejection.reject = true;
    await reconnect(setOffline);
    rejection.reject = false;
    const [parked] = queued("crm.lead");
    expect(parked.value.extras.error).toInclude("Save refused");
    expect([...form.crmOwnKeys]).toEqual([parked.key]);

    // Archive and unarchive, queued then replayed in turn: each key is tracked while
    // queued and dropped once replayed, whatever stays parked.
    for (const label of ["Archive", "Unarchive", "Archive"]) {
        await setOffline(true);
        await toggleActionMenu();
        await toggleMenuItem(label);
        if (label === "Archive") {
            await contains(".modal-footer .btn-primary").click();
        }
        expect(form.crmOwnKeys.size).toBe(2);
        await reconnect(setOffline);
        await expect.waitForSteps([
            {
                model: "crm.lead",
                method: `action_${label.toLowerCase()}`,
                args: [[1]],
                kwargs: { context: queuedContext(PIPELINE_ACTION.context) },
            },
        ]);
        expect([...form.crmOwnKeys]).toEqual([parked.key]);
    }

    // An activity queued for the lead, then discarded: tracked, then dropped.
    const plugin = getService(OfflinePlugin);
    await setOffline(true);
    const activityKey = plugin.scheduleORM(
        "mail.activity",
        "create",
        [[{ res_model: "crm.lead", res_id: 1, summary: "Call" }]],
        { context: {} },
        { extras: { actionId: PIPELINE_ACTION.id, displayName: "Lead 1", timeStamp: Date.now() } }
    );
    await animationFrame();
    expect(form.crmOwnKeys.has(activityKey)).toBe(true);
    plugin.removeScheduledORM(activityKey);
    await animationFrame();
    expect([...form.crmOwnKeys]).toEqual([parked.key]);
    expect(Object.keys(plugin._ormToSync())).toEqual([parked.key]);
});

test("[Offline] parked lead save opened from the systray online is handed to the form", async () => {
    stepWebSave();
    const rejection = rejectReplay("crm.lead", "web_save", "Save refused");
    stepLeadReads();
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();
    expect.verifySteps(["web_read [1]"]);

    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Lead 1 parked");
    await contains(".o_form_button_save").click();
    rejection.reject = true;
    await reconnect(setOffline);
    rejection.reject = false;
    expectParked("crm.lead", "Save refused");
    await goBack();

    // Opened from the systray online, the parked save leaves the queue and its
    // changes are handed to the form, unsaved: no reload drops them.
    await openSystray();
    await contains(
        ".o_offline_systray_content .o-dropdown-item:contains(Lead 1 parked) .text-truncate"
    ).click();
    await animationFrame();
    expect.verifySteps(["web_read [1]"]);
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Lead 1 parked");
    await contains(".o_form_button_save").click();
    expect.verifySteps([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { name: "Lead 1 parked" }],
            kwargs: {
                context: callContext(PIPELINE_ACTION.context),
                specification: leadFormReadBack(),
            },
        },
    ]);
    expect(MockServer.env["crm.lead"].browse(1)[0].name).toBe("Lead 1 parked");
});

/**
 * Parks an offline save of lead 1's expected revenue and probability (its replay is
 * rejected), changes the lead on the server, then opens the parked save from the
 * offline systray online. The form shows its cached read with the parked save's
 * changes, and the systray removes the entry, while the server's read is held; the
 * server's changed read then updates the form, whose changes stay unsaved edits.
 * Must be called after `stepLeadReads()`.
 *
 * @param {(offline: boolean) => Promise<void>} setOffline
 * @param {{reject: boolean}} rejection the `rejectReplay` state of `web_save`
 */
async function retryParkedSaveAfterServerChange(setOffline, rejection) {
    let heldRead = null;
    onRpc("crm.lead", "web_read", () => heldRead?.promise);
    await openPipeline();
    await openLead(1);
    await flushStartupSync();
    expect.verifySteps(["web_read [1]"]);

    await setOffline(true);
    await contains(".o_field_widget[name=expected_revenue] input").edit("8333");
    await contains(".o_field_widget[name=probability] input").edit("40");
    await contains(".o_form_button_save").click();
    rejection.reject = true;
    await reconnect(setOffline);
    rejection.reject = false;
    expectParked("crm.lead", "Save refused");
    await goBack();

    MockServer.env["crm.lead"].write([1], { phone: "+32 470 00 00 77" });
    heldRead = Promise.withResolvers();
    const { resolve } = heldRead;
    await openSystray();
    await contains(
        ".o_offline_systray_content .o-dropdown-item:contains(Lead 1) .text-truncate"
    ).click();
    await animationFrame();
    expect(queued("crm.lead")).toEqual([]);
    expect(".o_field_widget[name=phone] input").toHaveValue("+32 470 00 00 01");
    expect(".o_field_widget[name=expected_revenue] input").toHaveValue("8,333.00");
    expect(".o_field_widget[name=probability] input").toHaveValue("40.00");
    expect(".o_form_status_indicator_buttons").not.toHaveClass("invisible");

    heldRead = null;
    resolve();
    await animationFrame();
    expect.verifySteps(["web_read [1]"]);
    expect(".o_field_widget[name=phone] input").toHaveValue("+32 470 00 00 77");
    expect(".o_field_widget[name=expected_revenue] input").toHaveValue("8,333.00");
    expect(".o_field_widget[name=probability] input").toHaveValue("40.00");
    expect(".o_form_status_indicator_buttons").not.toHaveClass("invisible");
}

test("[Offline] parked lead save retried from the systray after a server change is saved", async () => {
    stepWebSave();
    const rejection = rejectReplay("crm.lead", "web_save", "Save refused");
    stepLeadReads();
    const setOffline = mockOffline();
    await retryParkedSaveAfterServerChange(setOffline, rejection);

    await contains(".o_form_button_save").click();
    expect.verifySteps([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { expected_revenue: 8333, probability: 40 }],
            kwargs: {
                context: callContext(PIPELINE_ACTION.context),
                specification: leadFormReadBack(),
            },
        },
    ]);
    const [lead] = MockServer.env["crm.lead"].browse(1);
    expect([lead.expected_revenue, lead.probability, lead.phone]).toEqual([
        8333,
        40,
        "+32 470 00 00 77",
    ]);
    expect(".o_form_status_indicator_buttons").toHaveClass("invisible");
});

test("[Offline] parked lead save retried from the systray after a server change is saved on leave", async () => {
    stepWebSave();
    const rejection = rejectReplay("crm.lead", "web_save", "Save refused");
    stepLeadReads();
    const setOffline = mockOffline();
    await retryParkedSaveAfterServerChange(setOffline, rejection);

    // Opened with cleared breadcrumbs, the form is left for another action.
    await getService("action").doAction(PIPELINE_ACTION.id);
    await animationFrame();
    expect.verifySteps([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { expected_revenue: 8333, probability: 40 }],
            kwargs: { context: callContext(PIPELINE_ACTION.context), specification: {} },
        },
    ]);
    const [lead] = MockServer.env["crm.lead"].browse(1);
    expect([lead.expected_revenue, lead.probability, lead.phone]).toEqual([
        8333,
        40,
        "+32 470 00 00 77",
    ]);
    expect(".o_form_view").toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
});

// Refine D3.2a (P2): an addon adding a header button before "Won", as sale_crm adds
// "New Quotation", moves "Won" under the phone header's "More" toggle, which the
// framework disables offline. While that toggle holds a lead-form button tagged
// available offline ("Won"), it stays available offline, so the offline mark-won is
// still reached on a phone; every other "More" toggle keeps the framework's state.

/** Lead form header as `sale_crm` extends it: "New Quotation" before "Won", then "Lost". */
const QUOTATION_FIRST_HEADER = /* xml */ `
    <header>
        <button name="action_sale_quotations_new" string="New Quotation" type="object" class="oe_highlight"
            invisible="type == 'lead' or probability == 0 and not active"/>
        <button name="action_set_won_rainbowman" string="Won" type="object" class="oe_highlight"
            data-hotkey="w" title="Mark as won" data-available-offline="1"
            invisible="won_status == 'won' or type == 'lead' or not active"/>
        <button name="${LOST_ACTION_ID}" string="Lost" type="action" data-hotkey="l" title="Mark as lost"
            invisible="won_status != 'pending' or not active"/>
        <field name="stage_id" widget="rotting_statusbar_duration"
            options="{'clickable': '1', 'fold_field': 'fold', 'crm_call_activity_type_id': ${CALL_ACTIVITY_TYPE_ID}}"
            invisible="type == 'lead'" readonly="won_status == 'lost' or not active"/>
    </header>`;

/** Lead form arch (`LEAD_FORM_ARCH`) with the `sale_crm` header. */
const LEAD_FORM_QUOTATION_FIRST_ARCH = LEAD_FORM_ARCH.replace(
    LEAD_FORM_HEADER,
    QUOTATION_FIRST_HEADER
);

/** The same lead form without "Won": "More" holds only "Lost", which is DISABLE. */
const LEAD_FORM_QUOTATION_NO_WON_ARCH = LEAD_FORM_QUOTATION_FIRST_ARCH.replace(
    /<button name="action_set_won_rainbowman"[^>]*\/>/,
    ""
);

const HEADER_QUOTATION = ".o_statusbar_buttons button[name=action_sale_quotations_new]";
const HEADER_MORE = ".o_statusbar_buttons button[title=More]";
const MORE_WON = ".o-dropdown--menu button[name=action_set_won_rainbowman]";
const MORE_LOST = `.o-dropdown--menu button[name='${LOST_ACTION_ID}']`;

test.tags("mobile");
test("[Offline] phone lead form reaches Won under the header's More toggle and queues it", async () => {
    registerInlineViewArchs("crm.lead", { "form,false": LEAD_FORM_QUOTATION_FIRST_ARCH });
    const setOffline = mockOffline();
    stepRoutes(
        (route) =>
            route === RAINBOWMAN_ROUTE ||
            /\/crm\.lead\/(action_set_won_rainbowman|action_sale_quotations_new)$/.test(route)
    );
    await openPipeline();
    await openLead(1);
    await flushStartupSync();

    // Online: the phone header shows "New Quotation", with "Won" and "Lost" under
    // "More", whose toggle carries the attribute (it has no effect online).
    expect(HEADER_QUOTATION).toHaveCount(1);
    expect(".o_statusbar_buttons button[name=action_set_won_rainbowman]").toHaveCount(0);
    expectAvailableOffline(HEADER_MORE);
    await contains(HEADER_MORE).click();
    expect(MORE_WON).toHaveCount(1);
    expect(MORE_LOST).toHaveCount(1);
    await contains(HEADER_MORE).click();
    expect(MORE_WON).toHaveCount(0);

    // Offline: "New Quotation" is guarded; "More" stays available and opens on an
    // enabled "Won" next to a guarded "Lost".
    await setOffline(true);
    expectGuarded(HEADER_QUOTATION, 1);
    expectAvailableOffline(HEADER_MORE);
    await contains(HEADER_MORE).click();
    expectAvailableOffline(MORE_WON);
    expectGuarded(MORE_LOST, 1);
    await contains(MORE_WON).click();

    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(".o_field_widget[name=probability]").toHaveText("100.00");
    const won = {
        model: "crm.lead",
        method: "action_set_won",
        args: [[1]],
        kwargs: { context: queuedContext(PIPELINE_ACTION.context) },
    };
    expect(queuedCalls("crm.lead")).toEqual([won]);
    // Neither the rainbowman variant nor the rainbowman lookup, nor "New Quotation".
    expect.verifySteps([]);

    await reconnect(setOffline);
    await expect.waitForSteps([won]);
    expect(queued("crm.lead")).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0]).toMatchObject({
        stage_id: STAGE_WON,
        won_status: "won",
        probability: 100,
    });
    expect.verifySteps([]);
});

test.tags("mobile");
test("[Offline] phone header More toggle holding no available-offline lead button stays framework-disabled", async () => {
    const setOffline = mockOffline();
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        arch: LEAD_FORM_QUOTATION_NO_WON_ARCH,
        config: { actionId: 1 },
    });
    await flushStartupSync();
    expect(HEADER_QUOTATION).toHaveCount(1);
    expect(HEADER_MORE).toHaveCount(1);
    expect(HEADER_MORE).not.toHaveAttribute("data-available-offline");

    await setOffline(true);
    expectGuarded(HEADER_QUOTATION, 1);
    expectFrameworkDisabled(HEADER_MORE);
    await click(HEADER_MORE);
    await animationFrame();
    expect(MORE_LOST).toHaveCount(0);

    await setOffline(false);
    await animationFrame();
    expect(HEADER_MORE).not.toHaveClass("o_disabled_offline");
    expect(HEADER_MORE).toBeEnabled();
    await contains(HEADER_MORE).click();
    expect(MORE_LOST).toHaveCount(1);
});

test.tags("mobile");
test("[Offline] phone header More toggle of another model's form keeps the framework state", async () => {
    const setOffline = mockOffline();
    // Not a lead form (`crm_form`): a button tagged available offline under "More"
    // leaves the toggle as the framework renders it.
    await mountView({
        type: "form",
        resModel: "res.partner",
        resId: serverState.partnerId,
        arch: /* xml */ `
            <form>
                <header>
                    <button name="action_first" string="First" type="object"/>
                    <button name="action_second" string="Second" type="object" data-available-offline="1"/>
                </header>
                <sheet>
                    <field name="name"/>
                </sheet>
            </form>`,
    });
    expect(HEADER_MORE).toHaveCount(1);
    expect(HEADER_MORE).not.toHaveAttribute("data-available-offline");

    await setOffline(true);
    expectFrameworkDisabled(HEADER_MORE);

    await setOffline(false);
    await animationFrame();
    expect(HEADER_MORE).not.toHaveClass("o_disabled_offline");
    expect(HEADER_MORE).toBeEnabled();
});

test.tags("mobile");
test("[Offline] non-secure origin disables the phone header More toggle holding Won", async () => {
    registerInlineViewArchs("crm.lead", { "form,false": LEAD_FORM_QUOTATION_FIRST_ARCH });
    const setOffline = mockOffline();
    stepRoutes((route) => /\/crm\.lead\/(action_set_won|action_set_won_rainbowman)$/.test(route));
    await openPipeline();
    // A non-secure origin, where the framework queue refuses every call (set after
    // the web client started, as in "non-secure origin disables Won").
    patchWithCleanup(window, { isSecureContext: false });
    await openLead(1);
    await flushStartupSync();
    expectAvailableOffline(HEADER_MORE);

    // Offline, "Won" could not be queued: the toggle holding it is framework-disabled.
    await setOffline(true);
    expectFrameworkDisabled(HEADER_MORE);
    await click(HEADER_MORE);
    await animationFrame();
    expect(MORE_WON).toHaveCount(0);
    expect(".ribbon:contains(Won)").toHaveCount(0);
    expect(queued("crm.lead")).toEqual([]);
    expect.verifySteps([]);

    // Online again, the toggle is available and "Won" marks the lead won.
    await setOffline(false);
    await animationFrame();
    expectAvailableOffline(HEADER_MORE);
    await contains(HEADER_MORE).click();
    await contains(MORE_WON).click();
    await expect.waitForSteps([
        buttonRoute("crm.lead", "action_set_won_rainbowman"),
        "action_set_won_rainbowman [1]",
    ]);
    await animationFrame();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(queued("crm.lead")).toEqual([]);
});

test.tags("desktop");
test("[Offline] desktop lead form header with a button before Won keeps Won inline", async () => {
    registerInlineViewArchs("crm.lead", { "form,false": LEAD_FORM_QUOTATION_FIRST_ARCH });
    const setOffline = mockOffline();
    await openPipeline();
    await openLead(1);
    await flushStartupSync();
    const wonButton = ".o_statusbar_buttons button[name=action_set_won_rainbowman]";
    expect(HEADER_MORE).toHaveCount(0);
    expect(".o_statusbar_buttons > button").toHaveCount(3);

    await setOffline(true);
    expect(HEADER_MORE).toHaveCount(0);
    expectGuarded(HEADER_QUOTATION, 1);
    expectAvailableOffline(wonButton);
    await contains(wonButton).click();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "action_set_won",
            args: [[1]],
            kwargs: { context: queuedContext(PIPELINE_ACTION.context) },
        },
    ]);
});
