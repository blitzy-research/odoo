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
        """ Resolve ``res_model_id`` for activities created on a ``crm.lead`` by model name.

        An activity scheduled offline from the CRM mobile activity sheet ("Log a call",
        "Schedule follow-up") is queued by the web client and replayed on reconnect as
        ``create([{'res_model': 'crm.lead', 'res_id': ..., ...}])``: the client cannot know the
        ``ir.model`` id offline. ``res_model`` is a readonly related field of ``res_model_id``
        with no inverse, so such values would create an activity detached from its lead.
        They are given the ``res_model_id`` that mail's ``default_get`` would resolve from the
        same model name, and ``res_model`` is dropped so it is recomputed from it.

        Values that already carry a ``res_model_id``, or that target another model, are left
        untouched, so every existing caller behaves as before. The lookup goes through
        ``ir.model._get``, which is cached and already sudoed; the create itself keeps the
        caller's access rights.

        e.g: ``create([{'res_model': 'crm.lead', 'res_id': lead.id, 'summary': 'Call'}])``
        creates an activity whose ``res_model_id.model`` is ``'crm.lead'``. """
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
