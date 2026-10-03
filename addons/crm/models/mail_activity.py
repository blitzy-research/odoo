# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import api, models


class MailActivity(models.Model):
    _inherit = "mail.activity"

    # ------------------------------------------------------------
    # ORM overrides
    # ------------------------------------------------------------

    @api.model_create_multi
    def create(self, vals_list):
        """ Resolve ``res_model_id`` for ``crm.lead`` values without a truthy identifier, removing
        the readonly ``res_model`` for recomputation. Offline name-based replay lacks ``ir.model``
        ids. The cached ``ir.model._get`` lookup is sudoed; activity creation retains the caller's
        rights. Explicit ids and other models pass through unchanged. """
        crm_lead_model_id = False
        for vals in vals_list:
            if vals.get("res_model") == "crm.lead" and not vals.get("res_model_id"):
                if not crm_lead_model_id:
                    crm_lead_model_id = self.env["ir.model"]._get("crm.lead").id
                vals["res_model_id"] = crm_lead_model_id
                vals.pop("res_model")
        return super().create(vals_list)

    # ------------------------------------------------------------
    # ACTIONS
    # ------------------------------------------------------------

    def action_create_calendar_event(self):
        """ Small override of the action that creates a calendar.

        If the activity is linked to a crm.lead through the "opportunity_id" field, we include in
        the action context the default values used when scheduling a meeting from the crm.lead form
        view.
        e.g: It will set the partner_id of the crm.lead as default attendee of the meeting. """

        action = super(MailActivity, self).action_create_calendar_event()
        opportunity = self.calendar_event_id.opportunity_id
        if opportunity:
            opportunity_action_context = opportunity.action_schedule_meeting(smart_calendar=False).get('context', {})
            opportunity_action_context['initial_date'] = self.calendar_event_id.start

            action['context'].update(opportunity_action_context)

        return action
