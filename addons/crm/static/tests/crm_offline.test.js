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

import { Component, xml } from "@odoo/owl";
import {
    advanceTime,
    beforeEach,
    expect,
    mockDate,
    mockUserAgent,
    runAllTimers,
    test,
} from "@odoo/hoot";
import {
    animationFrame,
    click,
    getFocusableElements,
    press,
    queryAll,
    queryAllTexts,
    queryFirst,
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
import { defineCrmModels } from "@crm/../tests/crm_test_helpers";
import { start, startServer } from "@mail/../tests/mail_test_helpers";
import { Composer } from "@mail/core/common/composer";
import { ActivityButton } from "@mail/core/web/activity_button";
import {
    CRM_MOBILE_ACTIVITY_LIMIT,
    CRM_OFFLINE_DISABLED_ACTIONS,
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
import { browser } from "@web/core/browser/browser";
import { router } from "@web/core/browser/router";
import { ConnectionLostError, RPCError } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { useService } from "@web/core/utils/hooks";
import { ActionMenus } from "@web/search/action_menus/action_menus";
import { computeM2OProps, Many2One } from "@web/views/fields/many2one/many2one";
import { buildM2OFieldDescription, Many2OneField } from "@web/views/fields/many2one/many2one_field";
import { Many2ManyTagsField } from "@web/views/fields/many2many_tags/many2many_tags_field";
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
    partner_email_update = fields.Boolean();
    partner_phone_update = fields.Boolean();
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
 * inherit adds); the unassigned-leads link on the card.
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
                    <field name="user_id" class="ms-auto"/>
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
 * Stand-in for the `res_partner_many2one` widget (`PartnerAutoCompleteMany2one`),
 * registered under that arch name for each test. Its addon, `partner_autocomplete`,
 * auto-installs with CRM's dependencies but is outside CRM's `depends`, so the
 * unit-test module set of `@crm` does not load it, and CRM (this file included)
 * imports nothing from it. The stand-in keeps the widget's contract: a many2one whose
 * `otherSources` adds the paid enrichment source, which loads the `jsvat` script
 * (stepped here) then calls `res.partner.autocomplete_by_name`, for queries longer
 * than two characters and only when the field can create.
 */
class EnrichmentPartnerMany2One extends Component {
    static template = xml`<Many2One t-props="this.m2oProps"/>`;
    static components = { Many2One };
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
                options: async (request) => {
                    if (!request || request.length <= 2) {
                        return [];
                    }
                    expect.step(JSVAT_SCRIPT);
                    const suggestions = await this.orm.silent.call(
                        "res.partner",
                        "autocomplete_by_name",
                        [request, false]
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
            kwargs: { context: callContext(), specification: {} },
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
                context: callContext({}, { default_stage_id: STAGE_NEW }),
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
        kwargs: { context: callContext(), specification: {} },
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

    // One create and one edit, in the order they were made.
    const kwargs = { context: callContext(), specification: {} };
    const createValues = queuedCalls("crm.lead")[0].args[1];
    expect(createValues).toMatchObject({ name: "Offline Lead", type: "opportunity" });
    const create = { model: "crm.lead", method: "web_save", args: [[], createValues], kwargs };
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
     * returns its queued create: the action's context (with `default_type`) and no
     * read-back specification.
     */
    async function createLeadOffline(name) {
        await contains(".o_field_widget[name=name] input").edit(name);
        await selectStage(STAGE_NEW, "New");
        await contains(".o_form_button_save").click();
        expect(".o_field_widget[name=name] input").toHaveValue(name);
        const [{ args }] = queuedCalls("crm.lead");
        expect(args[1]).toMatchObject({ name, type: "opportunity", stage_id: STAGE_NEW });
        const create = {
            model: "crm.lead",
            method: "web_save",
            args: [[], args[1]],
            kwargs: { context: callContext(PIPELINE_ACTION.context), specification: {} },
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
        const [{ args }] = queuedCalls("crm.lead");
        expect(args[1]).toMatchObject({ name });
        expect(queuedCalls("crm.lead")).toEqual([
            {
                model: "crm.lead",
                method: "web_save",
                args: [[], args[1]],
                kwargs: { context: callContext(), specification: {} },
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

    // Edits made after the offline save cannot reach the created lead: they are
    // dropped, never saved as a second create when the form is left.
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
        kwargs: { context: callContext(PIPELINE_ACTION.context), specification: {} },
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
            context: callContext(LIMITED_PIPELINE_ACTION.context, { default_stage_id: STAGE_NEW }),
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
        kwargs: { context: callContext(PIPELINE_ACTION.context) },
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
            context: callContext(PIPELINE_ACTION.context, { default_stage_id: STAGE_NEW }),
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
        kwargs: { context: callContext(), specification: {} },
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
        kwargs: { context: callContext(), specification: {} },
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
        kwargs: { context: callContext(PIPELINE_ACTION.context) },
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
        kwargs: { context: callContext(PIPELINE_ACTION.context) },
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
        kwargs: { context: callContext(PIPELINE_ACTION.context) },
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
    const context = callContext(PIPELINE_ACTION.context);
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
    const context = callContext(PIPELINE_ACTION.context);
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
                partner_email_update: false,
                partner_phone_update: false,
                phone: false,
                probability: 0,
                stage_id: false,
                team_id: false,
                type: "opportunity",
                user_id: false,
                won_status: "pending",
            },
        ],
        kwargs: { context: callContext(PIPELINE_ACTION.context), specification: {} },
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
        kwargs: { context: callContext(PIPELINE_ACTION.context) },
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
 * the stage header of each stage, browsed with "Next stage" from the first one.
 */
async function pipelineStageNames() {
    if (!isSmall()) {
        // A column title is followed by its record count, e.g. "New\n(3)".
        return queryAllTexts(".o_kanban_group .o_column_title").map((text) => text.split("\n")[0]);
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

/** Lead meetings, returned by Schedule Meeting (`crm.act_crm_opportunity_calendar_event_new`). */
const MEETING_ACTION = {
    id: 28,
    xml_id: "crm.act_crm_opportunity_calendar_event_new",
    name: "Meetings",
    res_model: "calendar.event",
    views: [[false, "list"]],
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
    }
}

/** Asserts that guarded CRM view buttons are back to their online state. */
function expectUnguarded(selector, count) {
    expect(selector).toHaveCount(count);
    for (const el of queryAll(selector)) {
        expect(el).not.toHaveClass("o_disabled_offline");
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

        // Back online, it applies.
        await setOffline(false);
        await animationFrame();
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
    // The forecast views are never marked available, even after a visit.
    const offlinePlugin = getService(OfflinePlugin);
    expect(offlinePlugin.isAvailableOffline(FORECAST_ACTION.id, "kanban")).toBe(false);
    expect(offlinePlugin.isAvailableOffline(FORECAST_ACTION.id, "list")).toBe(false);

    // Navbar: the forecast and report entries are dimmed (never-marked views); every
    // entry is inert by click, Enter, Space and a direct `selectMenu` (id or menu).
    for (const { id, section, xmlid, view } of DISABLED_MENUS) {
        const entry = await openNavbarEntry(section, xmlid);
        if (/\/(kanban|graph)$/.test(view)) {
            expect(entry).toHaveClass("o_disabled_offline");
        }
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
    // Direct `doAction` by `xml_id` and by numeric id (identified through the
    // disk-cached action loaded online with the same context).
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
    // Each disabled action is identified through its disk-cached load (the same
    // string request): the pipeline stays, with no helper, dialog or request.
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
    const setOffline = mockOffline();
    stepRoutes(
        (route) => route === "/web/action/load" || route.startsWith("/web/dataset/call_button/")
    );
    await mountWithCleanup(WebClient);
    await getService("action").doAction(TEAM_ACTION.id);
    await flushStartupSync();
    expect.verifySteps(["/web/action/load"]);
    const unassigned = `${EUROPE_CARD} a[name=action_open_unassigned_opportunities]`;
    expectUnguarded(unassigned, 1);

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
    if (queryAll(configuration).length) {
        await click(queryFirst(configuration));
        await settle();
    }
    expect(currentView()).toBe("sales_team.crm_team_action_pipeline/kanban");
    // Direct calls of the card's open/edit trigger.
    await europeCard.triggerAction({ type: "open" });
    await europeCard.triggerAction({ type: "edit" });
    await settle();
    expect(currentView()).toBe("sales_team.crm_team_action_pipeline/kanban");
    expect(".o_form_view").toHaveCount(0);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);

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
            route.startsWith("/web/dataset/call_button/") || route.includes("/ir.config_parameter/")
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
    expect(alert).toHaveCount(1);
    expect(alert).not.toHaveClass("d-none");

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
    await settle();
    expect(".modal").toHaveCount(0);
    expect(getService("action").currentController.action.res_model).toBe("crm.team");
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Europe");
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
    await expect.waitForSteps([
        buttonRoute("crm.team", "action_open_opportunities"),
        "action_open_opportunities [1]",
    ]);
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
    await setOffline(true);
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
    // The fallback form's create, with the share item's context and its default name.
    const [{ args }] = queuedCalls("crm.lead");
    expect(args[1]).toMatchObject({ name: "card.png", team_id: 1 });
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[], args[1]],
            kwargs: {
                context: callContext({}, { ...leadItem.context, default_name: "card.png" }),
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
    await activateByPointerAndKeyboard(counter);
    await callButton({ resModel: "utm.campaign", name: "action_redirect_to_leads_opportunities", resId: 1 });
    await settle();
    expect(currentView()).toBe("utm.utm_campaign_action/kanban");
    expect.verifySteps([]);

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

/**
 * Creates the partner "Azure Interior" and the enrichment lookup, then opens lead 1
 * in the full lead form.
 *
 * @returns {Promise<number>} the partner id
 */
async function openLeadWithPartnerField() {
    const { env } = await makeMockServer();
    const partnerId = env["res.partner"].create({ name: "Azure Interior" });
    onRpc("res.partner", "autocomplete_by_name", ({ args }) => {
        expect.step(`autocomplete_by_name ${args[0]}`);
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
    const partnerId = await openLeadWithPartnerField();
    // Online, a search caches the matching partner (and offers enrichment and creation).
    await searchPartner("Azu");
    expect.verifySteps([
        JSVAT_SCRIPT,
        "/web/dataset/call_kw/res.partner/autocomplete_by_name",
        "/web/dataset/call_kw/res.partner/web_name_search",
        "autocomplete_by_name Azu",
    ]);
    expect(queryAllTexts(PARTNER_OPTIONS)).toInclude("Azure Interior");
    expect(ENRICHMENT_OPTION).toHaveCount(1);
    expect(queryAllTexts(PARTNER_OPTIONS).some((text) => text.startsWith("Create"))).toBe(true);
    await press("Escape");
    await contains(PARTNER_INPUT).clear({ confirm: false });
    await animationFrame();

    // Offline: a new query (not the memoized one) is answered from the relational-field
    // cache alone, with no request attempted: no record search, no enrichment script or
    // lookup, and no Create, Create and edit or Search more.
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
    await contains(PARTNER_INPUT).edit("Interior", { confirm: false });
    // Past the autocomplete debounce only: the offline plugin's own connection check
    // (a timer) is not part of the search.
    await advanceTime(500);
    await animationFrame();
    expect(attemptedRoutes).toEqual([]);
    trackingAttempts = false;
    expect.verifySteps([]);
    expect(queryAllTexts(PARTNER_OPTIONS)).toEqual(["Azure Interior"]);
    expect(ENRICHMENT_OPTION).toHaveCount(0);
    expect(".o_m2o_dropdown_option").toHaveCount(0);
    // The cached partner is selected and saved through the queue.
    await contains(`${PARTNER_OPTIONS}:contains(Azure Interior)`).click();
    expect(PARTNER_INPUT).toHaveValue("Azure Interior");
    await contains(".o_form_button_save").click();
    expect(queuedCalls("crm.lead")).toEqual([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { partner_id: partnerId }],
            kwargs: { context: callContext(LEADS_ACTION.context), specification: {} },
        },
    ]);
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
});

test.tags("desktop");
test("[Online] partner field keeps enrichment source", async () => {
    stepRoutes((route) => route.includes("/res.partner/"));
    await openLeadWithPartnerField();
    // Two characters: the record search only.
    await searchPartner("Az");
    expect.verifySteps(["/web/dataset/call_kw/res.partner/web_name_search"]);
    expect(ENRICHMENT_OPTION).toHaveCount(0);
    // Three characters: the enrichment source loads its script and looks the name up.
    await searchPartner("Azu");
    expect.verifySteps([
        JSVAT_SCRIPT,
        "/web/dataset/call_kw/res.partner/autocomplete_by_name",
        "/web/dataset/call_kw/res.partner/web_name_search",
        "autocomplete_by_name Azu",
    ]);
    expect(ENRICHMENT_OPTION).toHaveCount(1);
    expect(ENRICHMENT_OPTION).toHaveText("Azure Interior SA");
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
            kwargs: { context: callContext(PIPELINE_ACTION.context), specification: {} },
        },
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_WON }],
            kwargs: {
                context: callContext(PIPELINE_ACTION.context, { default_stage_id: STAGE_NEW }),
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
        context: callContext(PIPELINE_ACTION.context, { default_stage_id: STAGE_NEW }),
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
    const context = callContext(PIPELINE_ACTION.context);
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
    await reconnect(setOffline);
    await expect.waitForSteps([
        {
            model: "crm.lead",
            method: "web_save",
            args: [[1], { stage_id: STAGE_QUALIFIED }],
            kwargs: { context, specification: {} },
        },
        { model: "crm.lead", method: "action_set_won", args: [[1]], kwargs: { context } },
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
            kwargs: { context, specification: {} },
        },
        { model: "crm.lead", method: "action_set_won", args: [[2]], kwargs: { context } },
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
            kwargs: { context, specification: {} },
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
            kwargs: { context: callContext(PIPELINE_ACTION.context), specification: {} },
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
                kwargs: { context: callContext(PIPELINE_ACTION.context) },
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
