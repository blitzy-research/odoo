# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import api, models
from odoo.exceptions import AccessError, ConcurrencyError
from odoo.tools import SQL

from .crm_lead import (
    CRM_OFFLINE_CREATE_KEY,
    CRM_OFFLINE_CREATE_KEY_RE,
    CRM_OFFLINE_CREATE_MODULE,
    CrmOfflineOriginError,
)


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
        rights. Explicit ids and other models pass through unchanged. A create queued offline by
        another user is refused first (``crm.lead`` ``_check_offline_queue_origin``).

        Create an activity at most once per delivery key of the CRM activity sheet ("Log a call",
        "Schedule follow-up"). The web client replays its offline queue at least once: a create
        whose answer was lost (the server committed it, then the connection dropped) stays queued
        and is sent again verbatim, and a create sent online whose answer was lost is queued with
        the very call it sent. The sheet therefore sends, with its online create and with the
        queued one alike, a delivery key of 32 lowercase hexadecimal digits in the
        ``CRM_OFFLINE_CREATE_KEY`` context key, the same for every delivery of one scheduled
        activity, as the mobile quick create does for its leads (``crm.lead`` ``web_save``). The
        first delivery of a single-value create creates the activity and registers the key as its
        external identifier ``__crm_offline__.<key>``: an ``ir.model.data`` row, so the activity
        model gains no field. A later delivery of that key by the activity's creator creates
        nothing and answers with that activity, done (archived) or not; a key registered by
        another user, or for another model, is refused. Of two concurrent deliveries of one key,
        only the first registers it: the later one's registration fails with a serialization
        failure, so the RPC layer rolls that delivery back with the activity it created and
        retries it, and the retry answers with the activity the first one created.

        A keyed create whose context ``uid`` (sent by the web client with every call, its queued
        ones included) names another user than the caller is refused (``CrmOfflineOriginError``)
        before anything is looked up, created or registered. Everything runs under the caller's
        rights except the ``ir.model.data`` lookup and registration, made as superuser on that
        fixed module with a validated key. Deleting an activity deletes its external identifiers
        (base ``unlink``), so a delivery after the deletion creates it again. Creates without a
        valid key, or of several values (a key names one activity), keep the base behaviour. """
        self.env['crm.lead']._check_offline_queue_origin()
        key = self.env.context.get(CRM_OFFLINE_CREATE_KEY)
        keyed = len(vals_list) == 1 and isinstance(key, str) and bool(CRM_OFFLINE_CREATE_KEY_RE.fullmatch(key))
        activities = self
        data = None
        if keyed:
            origin_uid = self.env.context.get('uid')
            if isinstance(origin_uid, int) and not isinstance(origin_uid, bool) and origin_uid != self.env.uid:
                raise CrmOfflineOriginError(self.env._("This offline change was sent in another user's session and was not applied."))
            # the key only selects the delivery: the create itself sees the caller's context
            activities = self.with_context({k: v for k, v in self.env.context.items() if k != CRM_OFFLINE_CREATE_KEY})
            data = self.env['ir.model.data'].sudo().search(
                [('module', '=', CRM_OFFLINE_CREATE_MODULE), ('name', '=', key)], limit=1,
            )
            if data:
                delivered = self.sudo().browse(data.res_id).exists() if data.model == self._name else None
                if delivered is None or (delivered and delivered.create_uid.id != self.env.uid):
                    raise AccessError(self.env._("This activity was already created by another user."))
                if delivered:
                    return activities.browse(delivered.id)

        crm_lead_model_id = False
        for vals in vals_list:
            if vals.get("res_model") == "crm.lead" and not vals.get("res_model_id"):
                if not crm_lead_model_id:
                    crm_lead_model_id = self.env["ir.model"]._get("crm.lead").id
                vals["res_model_id"] = crm_lead_model_id
                vals.pop("res_model")
        created = super(MailActivity, activities).create(vals_list)
        if keyed:
            if data:
                # an external identifier left by an activity deleted without the ORM
                data.res_id = created.id
            else:
                self._crm_register_offline_create_key(key, created)
        return created

    def _crm_register_offline_create_key(self, key, activity):
        """ Register ``key`` as the external identifier ``__crm_offline__.<key>`` of ``activity``.

        Registered in SQL rather than through the ORM, as the ``crm.lead`` ``web_save`` registers
        its keys. Under the cursor's repeatable read snapshot, a registration of this key committed
        by a concurrent delivery after the caller's lookup makes the insert raise a serialization
        failure, which the RPC layer retries; the ORM create would raise a unique violation, which
        it answers as a validation error. The expected failure is not logged as a bad query.

        :param str key: a validated delivery key (``CRM_OFFLINE_CREATE_KEY_RE``)
        :param activity: the ``mail.activity`` record the delivery created
        :raise ConcurrencyError: when the key was registered by a delivery the caller's lookup
            did not see, so that the call is retried and answered with that delivery's activity
        """
        now = self.env.cr.now()
        self.env.cr.execute(SQL(
            """ INSERT INTO ir_model_data
                    (module, name, model, res_id, noupdate, create_uid, create_date, write_uid, write_date)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (module, name) DO NOTHING
                RETURNING id """,
            CRM_OFFLINE_CREATE_MODULE, key, self._name, activity.id, True,
            self.env.uid, now, self.env.uid, now,
        ), log_exceptions=False)
        if not self.env.cr.fetchone():
            # registered by a delivery the lookup should have found:
            # never answer without the key registered, have the call retried
            raise ConcurrencyError(f"Delivery key {key} of a {self._name} create was registered concurrently")

    # ------------------------------------------------------------
    # ACTIONS
    # ------------------------------------------------------------

    def action_done(self):
        """ Refuse a mark done queued offline by another user (``crm.lead``
        ``_check_offline_queue_origin``); marking done itself is unchanged. """
        self.env['crm.lead']._check_offline_queue_origin()
        return super().action_done()

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
