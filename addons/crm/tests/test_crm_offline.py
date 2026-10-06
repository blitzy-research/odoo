# Part of Odoo. See LICENSE file for full copyright and licensing details.

import ast
import copy
import secrets
from contextlib import contextmanager
from datetime import timedelta
from unittest.mock import patch

from lxml import etree

from odoo import fields
from odoo.exceptions import AccessError, UserError
from odoo.tests import HttpCase
from odoo.tests.common import JsonRpcException, tagged
from odoo.tools import file_open, mute_logger

from odoo.addons.crm.models.crm_lead import CrmOfflineOriginError
from odoo.addons.crm.tests.common import TestCrmCommon
from odoo.addons.mail.tests.common import mail_new_test_user
from odoo.addons.web.controllers.webmanifest import WebManifest as WebManifestBase


@tagged('post_install', '-at_install')
class TestCrmOffline(HttpCase, TestCrmCommon):
    """ Server side of the CRM offline-capable mobile experience.

    The web client queues every offline write and replays it verbatim on
    reconnect, through ``orm.silent.call(model, method, args, kwargs)``. Each
    replay test below therefore runs the exact call the client queues, as the
    salesperson who queued it (``user_sales_salesman``, who only sees their own
    or unassigned leads, so every lead used here is assigned to them), and
    checks the server reaches the state the client showed optimistically.

    The class also checks the PWA manifest shortcuts, the view, asset and
    version wiring of the feature, and runs the ``crm_mobile_offline`` tour,
    the full offline write-and-replay cycle on a phone-sized touch browser
    (``browser_size`` / ``touch_enabled`` are read by every browser this class
    starts, and ``url_open`` does not start one).
    """

    browser_size = "375x667"
    touch_enabled = True

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.call_type = cls.env.ref('mail.mail_activity_data_call')
        cls.todo_type = cls.env.ref('mail.mail_activity_data_todo')
        # "My Pipeline": the queued pipeline calls carry this action's context
        # (the form record context and the pipeline list context both start
        # from it), and the pipeline only lists records of its domain.
        cls.pipeline_action = cls.env.ref('crm.crm_lead_action_pipeline')
        cls.pipeline_context = ast.literal_eval(cls.pipeline_action.context)
        cls.pipeline_domain = ast.literal_eval(cls.pipeline_action.domain)

    @classmethod
    def _create_salesman_opportunity(cls, name, **vals):
        """ Create an opportunity of ``user_sales_salesman`` in the first generic
        stage, the first pipeline stage of that user, who is in no sales team.

        :param str name: lead name
        :param vals: extra ``crm.lead`` values, overriding the defaults above
        :return: the new ``crm.lead`` record, in the test (superuser) environment
        """
        return cls.env['crm.lead'].create({
            'name': name,
            'type': 'opportunity',
            'user_id': cls.user_sales_salesman.id,
            'stage_id': cls.stage_gen_1.id,
            **vals,
        })

    def _get_activity_done_messages(self, lead, activity_type):
        """ Return the messages ``mail.activity._action_done`` posted on ``lead``
        for activities of ``activity_type``: they tell an activity marked done
        apart from one that was merely deleted. """
        return lead.message_ids.filtered(lambda message: message.mail_activity_type_id == activity_type)

    # ------------------------------------------------------------
    # PWA manifest
    # ------------------------------------------------------------

    def test_webmanifest_crm_shortcuts(self):
        """ The manifest keeps the web shortcuts unchanged and first, then lists
        "My Pipeline" and "New Lead" in the parent's shape, both opening the
        pipeline menu, with the CRM app icon. Nothing else in it changes. """
        self.authenticate('user_sales_salesman', 'user_sales_salesman')

        # The parent result is captured as the web controller returned it, before
        # CRM's override (which reaches it through super()) appends to the list.
        original_get_shortcuts = WebManifestBase._get_shortcuts
        parent_results = []

        def spy_get_shortcuts(controller):
            result = original_get_shortcuts(controller)
            parent_results.append(copy.deepcopy(result))
            return result

        with patch.object(WebManifestBase, '_get_shortcuts', spy_get_shortcuts):
            response = self.url_open('/web/manifest.webmanifest')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Content-Type'], 'application/manifest+json')
        data = response.json()
        self.assertTrue(parent_results, "The CRM override must build on the web controller's shortcuts")
        parent = parent_results[-1]
        shortcuts = data['shortcuts']

        self.assertEqual(shortcuts[:len(parent)], parent)
        self.assertEqual(len(shortcuts), len(parent) + 2, "Exactly two CRM shortcuts are appended")
        crm_app_url = '/odoo?menu_id=%s' % self.env.ref('crm.crm_menu_root').id
        crm_app_entries = [shortcut for shortcut in parent if shortcut['url'] == crm_app_url]
        self.assertEqual(len(crm_app_entries), 1, "The parent lists the CRM app")

        pipeline_shortcut, new_lead_shortcut = shortcuts[len(parent):]
        self.assertEqual(pipeline_shortcut['name'], "My Pipeline")
        self.assertEqual(new_lead_shortcut['name'], "New Lead")
        expected_icons = [{'sizes': '100x100', 'src': '/crm/static/description/icon.png', 'type': 'image/png'}]
        self.assertEqual(crm_app_entries[0]['icons'], expected_icons)
        for shortcut in (pipeline_shortcut, new_lead_shortcut):
            with self.subTest(shortcut=shortcut['name']):
                self.assertEqual(set(shortcut), {'name', 'url', 'description', 'icons'})
                self.assertTrue(shortcut['description'])
                self.assertTrue(shortcut['url'].startswith('/odoo?menu_id='))
                self.assertEqual(shortcut['icons'], expected_icons)

        pipeline_url = '/odoo?menu_id=%s' % self.env.ref('crm.menu_crm_opportunities').id
        self.assertEqual(pipeline_shortcut['url'], pipeline_url)
        self.assertTrue(new_lead_shortcut['url'].startswith(pipeline_url))
        self.assertTrue(new_lead_shortcut['url'].endswith('&crm_quick_create=1'))
        self.assertEqual(new_lead_shortcut['url'], pipeline_url + '&crm_quick_create=1')

        icon_response = self.url_open(expected_icons[0]['src'])
        self.assertEqual(icon_response.status_code, 200)
        self.assertTrue(icon_response.headers['Content-Type'].startswith('image/png'))

        self.assertEqual(data['background_color'], '#714B67')
        self.assertEqual(data['theme_color'], '#714B67')
        self.assertIn('share_target', data)
        self.assertCountEqual(data['icons'], [
            {'src': '/web/static/img/odoo-icon-192x192.png', 'sizes': '192x192', 'type': 'image/png'},
            {'src': '/web/static/img/odoo-icon-512x512.png', 'sizes': '512x512', 'type': 'image/png'},
        ])

    def test_webmanifest_crm_shortcuts_unauthenticated(self):
        """ Without a session the parent lists no shortcut (it gets an
        AccessError), so CRM finds no app entry and appends nothing. """
        response = self.url_open('/web/manifest.webmanifest')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Content-Type'], 'application/manifest+json')
        self.assertEqual(response.json()['shortcuts'], [])

    def test_webmanifest_crm_shortcuts_without_crm_menus(self):
        """ An internal user who cannot see the CRM menus gets the shortcuts of
        their other apps from the parent but no CRM app entry, so CRM appends
        nothing and the parent list is returned unchanged. """
        user_employee = mail_new_test_user(
            self.env, login='user_employee_no_crm',
            name='Ernest Employee', email='employee_no_crm@test.example.com',
            groups='base.group_user',
        )
        crm_root = self.env.ref('crm.crm_menu_root')
        self.assertNotIn(crm_root, self.env['ir.ui.menu'].with_user(user_employee).get_user_roots())
        self.authenticate('user_employee_no_crm', 'user_employee_no_crm')

        original_get_shortcuts = WebManifestBase._get_shortcuts
        parent_results = []

        def spy_get_shortcuts(controller):
            result = original_get_shortcuts(controller)
            parent_results.append(copy.deepcopy(result))
            return result

        with patch.object(WebManifestBase, '_get_shortcuts', spy_get_shortcuts):
            response = self.url_open('/web/manifest.webmanifest')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Content-Type'], 'application/manifest+json')
        self.assertTrue(parent_results, "The CRM override must build on the web controller's shortcuts")
        parent = parent_results[-1]
        parent_urls = [shortcut['url'] for shortcut in parent]
        discuss_url = '/odoo?menu_id=%s' % self.env.ref('mail.menu_root_discuss').id
        self.assertIn(discuss_url, parent_urls, "The parent lists the user's other apps")
        self.assertNotIn('/odoo?menu_id=%s' % crm_root.id, parent_urls, "The parent has no CRM app entry")

        shortcuts = response.json()['shortcuts']
        self.assertEqual(shortcuts, parent, "Without the CRM app entry the parent list is returned unchanged")
        pipeline_url = '/odoo?menu_id=%s' % self.env.ref('crm.menu_crm_opportunities').id
        self.assertNotIn(pipeline_url, [shortcut['url'].split('&')[0] for shortcut in shortcuts])

    # ------------------------------------------------------------
    # Replay of the calls queued offline
    # ------------------------------------------------------------

    def test_offline_edit_replay_matches_online(self):
        """ An offline lead form save queues ``web_save [[resId], changes]`` with
        ``{specification: {}}``, where ``changes`` holds the user's edit plus the
        email and phone the CRM form forces into the changes so they reach the
        partner. Replaying it must give the same lead and partner as the online
        save of the same edit, which reads a full specification back. """
        salesman = self.user_sales_salesman
        partner_a, partner_b = self.env['res.partner'].create([
            {'name': 'Twin Partner A'},
            {'name': 'Twin Partner B'},
        ])
        lead_a, lead_b = (
            self._create_salesman_opportunity(
                name, partner_id=partner.id, email_from='test@example.com', phone='+32 494 44 44 44',
            )
            for name, partner in (('Twin Lead A', partner_a), ('Twin Lead B', partner_b))
        )
        (partner_a + partner_b).write({'email': False, 'phone': False})

        # initial state: both partners lost their email and phone, which the leads
        # still hold, so a save of either lead propagates them
        for lead, partner in ((lead_a, partner_a), (lead_b, partner_b)):
            with self.subTest(lead=lead.name):
                self.assertFalse(partner.email)
                self.assertFalse(partner.phone)
                self.assertEqual(lead.email_from, 'test@example.com')
                self.assertEqual(lead.phone, '+32 494 44 44 44')
                self.assertTrue(lead.partner_email_update)
                self.assertTrue(lead.partner_phone_update)

        changes = {
            'expected_revenue': 1234.0,
            'email_from': 'test@example.com',
            'phone': '+32 494 44 44 44',
        }

        # lead A: the replayed queue entry, exactly as queued
        result_a = lead_a.with_user(salesman).web_save(changes, specification={})
        self.assertEqual(result_a, [{'id': lead_a.id}])

        # lead B: the online save of the same edit
        result_b = lead_b.with_user(salesman).web_save(dict(changes), specification={
            'expected_revenue': {},
            'email_from': {},
            'phone': {},
            'partner_id': {'fields': {'display_name': {}}},
        })
        self.assertEqual(result_b, [{
            'id': lead_b.id,
            'expected_revenue': 1234.0,
            'email_from': 'test@example.com',
            'phone': '+32 494 44 44 44',
            'partner_id': {'id': partner_b.id, 'display_name': 'Twin Partner B'},
        }])

        self.env.invalidate_all()
        for lead, partner in ((lead_a, partner_a), (lead_b, partner_b)):
            with self.subTest(lead=lead.name):
                self.assertEqual(lead.expected_revenue, 1234)
                self.assertEqual(lead.email_from, 'test@example.com')
                self.assertEqual(lead.phone, '+32 494 44 44 44')
                self.assertEqual(partner.email, 'test@example.com', 'Should have propagated the lead email on the partner')
                self.assertEqual(partner.phone, '+32 494 44 44 44', 'Should have propagated the lead phone on the partner')
                self.assertFalse(lead.partner_email_update)
                self.assertFalse(lead.partner_phone_update)

        for fname in ('expected_revenue', 'email_from', 'phone', 'partner_email_update', 'partner_phone_update'):
            self.assertEqual(lead_a[fname], lead_b[fname], f'Replayed and online saves differ on lead {fname}')
        for fname in ('email', 'phone'):
            self.assertEqual(partner_a[fname], partner_b[fname], f'Replayed and online saves differ on partner {fname}')

    def test_offline_partner_change_replay_matches_online(self):
        """ A partner chosen offline in the lead form gets no onchange, so the
        CRM form queues ``web_save [[resId], {partner_id}]`` with
        ``{specification: {}}``: neither the lead's email and phone nor the flags
        loaded for the previous partner are forced. Replaying it must give the
        same lead and partners as the online save, whose onchange takes the
        email and phone of the new partner into the changes. """
        salesman = self.user_sales_salesman
        partner_a, partner_b = self.env['res.partner'].create([
            {'name': 'Twin Partner A'},
            {'name': 'Twin Partner B'},
        ])
        new_partner = self.env['res.partner'].create({
            'name': 'New Partner',
            'email': 'new.partner@example.com',
            'phone': '+32 470 99 99 99',
        })
        lead_a, lead_b = (
            self._create_salesman_opportunity(
                name, partner_id=partner.id, email_from='lead.own@example.com', phone='+32 494 12 12 12',
            )
            for name, partner in (('Twin Lead A', partner_a), ('Twin Lead B', partner_b))
        )
        (partner_a + partner_b).write({'email': False, 'phone': False})

        # initial state: the leads' own email and phone differ from their partner's,
        # so a save of either lead without a partner change would propagate them
        for lead in lead_a + lead_b:
            with self.subTest(lead=lead.name):
                self.assertEqual(lead.email_from, 'lead.own@example.com')
                self.assertEqual(lead.phone, '+32 494 12 12 12')
                self.assertTrue(lead.partner_email_update)
                self.assertTrue(lead.partner_phone_update)

        # lead A: the replayed queue entry, exactly as queued
        result_a = lead_a.with_user(salesman).web_save({'partner_id': new_partner.id}, specification={})
        self.assertEqual(result_a, [{'id': lead_a.id}])

        # lead B: the online save, with the values the partner onchange gives
        result_b = lead_b.with_user(salesman).web_save({
            'partner_id': new_partner.id,
            'email_from': 'new.partner@example.com',
            'phone': '+32 470 99 99 99',
        }, specification={
            'email_from': {},
            'phone': {},
            'partner_id': {'fields': {'display_name': {}}},
        })
        self.assertEqual(result_b, [{
            'id': lead_b.id,
            'email_from': 'new.partner@example.com',
            'phone': '+32 470 99 99 99',
            'partner_id': {'id': new_partner.id, 'display_name': 'New Partner'},
        }])

        self.env.invalidate_all()
        for lead in lead_a + lead_b:
            with self.subTest(lead=lead.name):
                self.assertEqual(lead.partner_id, new_partner)
                self.assertEqual(lead.email_from, 'new.partner@example.com')
                self.assertEqual(lead.phone, '+32 470 99 99 99')
                self.assertFalse(lead.partner_email_update)
                self.assertFalse(lead.partner_phone_update)
        self.assertEqual(new_partner.email, 'new.partner@example.com', 'Should have kept the new partner email')
        self.assertEqual(new_partner.phone, '+32 470 99 99 99', 'Should have kept the new partner phone')
        for partner in partner_a + partner_b:
            with self.subTest(partner=partner.name):
                self.assertFalse(partner.email)
                self.assertFalse(partner.phone)

        for fname in ('partner_id', 'email_from', 'phone', 'partner_email_update', 'partner_phone_update'):
            self.assertEqual(lead_a[fname], lead_b[fname], f'Replayed and online saves differ on lead {fname}')

    def test_offline_mark_won_replay(self):
        """ Won clicked offline queues ``action_set_won [[resId]]`` with the form
        context, never ``action_set_won_rainbowman``: the server picks the won
        stage when the call replays. The replayed lead must end in the same state
        as a twin lead won online through the form's ``action_set_won_rainbowman``. """
        salesman = self.user_sales_salesman
        lead = self._create_salesman_opportunity('Offline Won Lead', expected_revenue=500)
        online_lead = self._create_salesman_opportunity('Online Won Lead', expected_revenue=500)
        self.assertEqual(lead.won_status, 'pending')
        self.assertFalse(lead.stage_id.is_won)
        self.assertEqual(online_lead.won_status, 'pending')

        result = lead.with_user(salesman).with_context(self.pipeline_context).action_set_won()
        self.assertTrue(result)

        lead.invalidate_recordset()
        self.assertEqual(lead.won_status, 'won')
        self.assertTrue(lead.stage_id.is_won)
        self.assertEqual(lead.stage_id, self.stage_gen_won)
        self.assertEqual(lead.probability, 100)

        # online twin: the Won button, whose returned rainbowman effect is UI only
        online_result = online_lead.with_user(salesman).with_context(self.pipeline_context).action_set_won_rainbowman()
        self.assertTrue(online_result)

        online_lead.invalidate_recordset()
        for fname in ('won_status', 'stage_id', 'probability', 'active', 'user_id', 'team_id'):
            self.assertEqual(lead[fname], online_lead[fname], f'Replayed and online Won differ on lead {fname}')
        for won_lead in (lead, online_lead):
            with self.subTest(lead=won_lead.name):
                self.assertTrue(won_lead.date_closed, 'Won sets the closing date')

    def test_offline_activity_create_replay(self):
        """ "Log a call" and "Schedule follow-up" offline queue a ``mail.activity``
        ``create`` naming the document by ``res_model`` only, as the client has no
        ``ir.model`` id offline. ``res_model`` is a readonly related field, so the
        activity is linked to its lead only through CRM's ``create`` override,
        which resolves ``res_model_id``: without it this test fails. The replay
        must give the activity and lead activity state that the online "Schedule
        Activity" dialog gives a twin lead for the same values. """
        salesman = self.user_sales_salesman
        lead = self._create_salesman_opportunity('Offline Activity Lead')
        online_lead = self._create_salesman_opportunity('Online Activity Lead')
        today = fields.Date.today()

        # the queued values, JSON-serialized: the deadline is a "YYYY-MM-DD" string
        activity = self.env['mail.activity'].with_user(salesman).create([{
            'res_model': 'crm.lead',
            'res_id': lead.id,
            'activity_type_id': self.call_type.id,
            'summary': 'Call',
            'date_deadline': fields.Date.to_string(today),
            'user_id': salesman.id,
        }])

        self.env.invalidate_all()
        self.assertEqual(len(activity), 1)
        # ir.model is not readable by salespersons: the link is read as superuser
        self.assertEqual(activity.sudo().res_model_id.model, 'crm.lead')
        self.assertEqual(activity.res_model, 'crm.lead')
        self.assertEqual(activity.res_id, lead.id)
        self.assertEqual(activity.activity_type_id, self.call_type)
        self.assertEqual(activity.summary, 'Call')
        self.assertEqual(activity.date_deadline, today)
        self.assertEqual(activity.user_id, salesman)
        self.assertIn(activity, lead.activity_ids)
        self.assertIn(activity, lead.with_user(salesman).activity_ids)

        # online twin: the web client's "Schedule Activity" dialog (chatter, card
        # activities) is the mail.activity.schedule wizard, saved with these values
        scheduler = self.env['mail.activity.schedule'].with_user(salesman).with_context(
            active_model='crm.lead', active_ids=[online_lead.id], active_id=online_lead.id,
        ).create({
            'activity_type_id': self.call_type.id,
            'summary': 'Call',
            'date_deadline': fields.Date.to_string(today),
            'activity_user_id': salesman.id,
        })
        scheduler.action_schedule_activities()

        self.env.invalidate_all()
        online_activity = online_lead.activity_ids
        self.assertEqual(len(online_activity), 1)
        self.assertEqual(online_activity.res_id, online_lead.id)
        self.assertIn(online_activity, online_lead.with_user(salesman).activity_ids)
        # ir.model is not readable by salespersons: the activities are compared as superuser
        for fname in (
            'res_model_id', 'res_model', 'activity_type_id', 'summary', 'note', 'date_deadline',
            'user_id', 'automated', 'state',
        ):
            self.assertEqual(
                activity.sudo()[fname], online_activity.sudo()[fname],
                f'Replayed and online activities differ on {fname}',
            )
        for fname in ('activity_state', 'activity_date_deadline', 'activity_summary', 'activity_type_id', 'activity_user_id'):
            self.assertEqual(lead[fname], online_lead[fname], f'Replayed and online activities differ on lead {fname}')

    def test_offline_activity_create_replay_batch(self):
        """ The resolution is made per value of a ``create`` batch: each value
        naming a ``crm.lead`` by ``res_model`` only gets its ``res_model_id``,
        a value that already carries ``res_model_id`` keeps it, even when it
        also names ``crm.lead`` by ``res_model``, and a value of another model
        is left on that model. The second ``res_model``-only value comes last,
        after the values that carry ``res_model_id``. """
        salesman = self.user_sales_salesman
        call_lead, resolved_lead, follow_up_lead = (
            self._create_salesman_opportunity(name)
            for name in ('Batch Call Lead', 'Batch Resolved Lead', 'Batch Follow-up Lead')
        )
        partner, call_back_partner = self.contact_2, self.contact_1
        # ir.model is not readable by salespersons: the model ids are read as superuser
        crm_lead_model = self.env['ir.model']._get('crm.lead')
        partner_model = self.env['ir.model']._get('res.partner')
        today = fields.Date.today()
        follow_up_day = today + timedelta(days=3)

        activities = self.env['mail.activity'].with_user(salesman).create([{
            'res_model': 'crm.lead',
            'res_id': call_lead.id,
            'activity_type_id': self.call_type.id,
            'summary': 'Call',
            'date_deadline': fields.Date.to_string(today),
            'user_id': salesman.id,
        }, {
            'res_model_id': crm_lead_model.id,
            'res_id': resolved_lead.id,
            'activity_type_id': self.call_type.id,
            'summary': 'Resolved Call',
            'date_deadline': fields.Date.to_string(today),
            'user_id': salesman.id,
        }, {
            'res_model_id': partner_model.id,
            'res_id': partner.id,
            'activity_type_id': self.todo_type.id,
            'summary': 'Partner Follow-up',
            'date_deadline': fields.Date.to_string(follow_up_day),
            'user_id': salesman.id,
        }, {
            'res_model': 'crm.lead',
            'res_model_id': partner_model.id,
            'res_id': call_back_partner.id,
            'activity_type_id': self.call_type.id,
            'summary': 'Partner Call Back',
            'date_deadline': fields.Date.to_string(today),
            'user_id': salesman.id,
        }, {
            'res_model': 'crm.lead',
            'res_id': follow_up_lead.id,
            'activity_type_id': self.todo_type.id,
            'summary': 'Follow-up',
            'date_deadline': fields.Date.to_string(follow_up_day),
            'user_id': salesman.id,
        }])

        self.env.invalidate_all()
        expected = [
            (crm_lead_model, call_lead, self.call_type, 'Call', today),
            (crm_lead_model, resolved_lead, self.call_type, 'Resolved Call', today),
            (partner_model, partner, self.todo_type, 'Partner Follow-up', follow_up_day),
            (partner_model, call_back_partner, self.call_type, 'Partner Call Back', today),
            (crm_lead_model, follow_up_lead, self.todo_type, 'Follow-up', follow_up_day),
        ]
        self.assertEqual(len(activities), len(expected))
        for activity, (model, document, activity_type, summary, date_deadline) in zip(activities, expected):
            with self.subTest(summary=summary):
                self.assertEqual(activity.sudo().res_model_id.model, document._name)
                self.assertEqual(activity.sudo().res_model_id, model)
                self.assertEqual(activity.res_model, document._name)
                self.assertEqual(activity.res_id, document.id)
                self.assertEqual(activity.activity_type_id, activity_type)
                self.assertEqual(activity.summary, summary)
                self.assertEqual(activity.date_deadline, date_deadline)
                self.assertEqual(activity.user_id, salesman)
                self.assertEqual(document.activity_ids, activity)
                self.assertEqual(document.with_user(salesman).activity_ids, activity)

    def test_offline_activity_create_replay_invalid_deadline(self):
        """ A replayed activity ``create`` the ORM rejects fails as it would
        without CRM's override, which neither swallows nor replaces the error:
        a deadline that is not a date raises the ``ValueError`` of the date
        conversion, and no activity is left on the lead. """
        salesman = self.user_sales_salesman
        lead = self._create_salesman_opportunity('Invalid Deadline Lead')
        with self.assertRaises(ValueError) as conversion_error:
            fields.Date.to_date('not-a-date')

        with self.assertRaises(ValueError) as create_error, self.cr.savepoint():
            self.env['mail.activity'].with_user(salesman).create([{
                'res_model': 'crm.lead',
                'res_id': lead.id,
                'activity_type_id': self.call_type.id,
                'summary': 'Call',
                'date_deadline': 'not-a-date',
                'user_id': salesman.id,
            }])
        self.assertEqual(create_error.exception.args, conversion_error.exception.args)

        self.env.invalidate_all()
        self.assertFalse(self.env['mail.activity'].with_context(active_test=False).search([
            ('res_model', '=', 'crm.lead'),
            ('res_id', '=', lead.id),
        ]))
        self.assertFalse(lead.activity_ids)

    def test_offline_activity_done_replay(self):
        """ "Mark done" offline queues ``mail.activity`` ``action_done
        [[activityId]]``: a state change only, with no feedback, attachment or
        next activity. Replayed, the activity leaves the lead's activities. The
        replay must give the outcome of the online "Mark Done" on a twin lead. """
        salesman = self.user_sales_salesman
        lead = self._create_salesman_opportunity('Offline Done Lead')
        activity = lead.activity_schedule('mail.mail_activity_data_todo', summary='Done Me', user_id=salesman.id)
        self.assertEqual(lead.activity_ids, activity)
        self.assertFalse(self._get_activity_done_messages(lead, self.todo_type))
        online_lead = self._create_salesman_opportunity('Online Done Lead')
        online_activity = online_lead.activity_schedule('mail.mail_activity_data_todo', summary='Done Me', user_id=salesman.id)
        self.assertEqual(online_lead.activity_ids, online_activity)
        self.assertFalse(self._get_activity_done_messages(online_lead, self.todo_type))

        activity.with_user(salesman).action_done()

        lead.invalidate_recordset(['activity_ids'])
        self.assertNotIn(activity, lead.activity_ids)
        self.assertFalse(activity.exists() and activity.active, 'A done activity is archived or unlinked')
        self.assertEqual(len(self._get_activity_done_messages(lead, self.todo_type)), 1, 'Marking done posts its message')

        # online twin: the web client's "Mark Done" with no feedback typed calls
        # action_feedback with the empty attachment list only
        online_activity.with_user(salesman).action_feedback(attachment_ids=[])

        online_lead.invalidate_recordset(['activity_ids'])
        self.assertNotIn(online_activity, online_lead.activity_ids)
        self.assertEqual(
            (bool(activity.exists()), activity.exists().active),
            (bool(online_activity.exists()), online_activity.exists().active),
            'Replayed and online Mark Done differ on keeping the done activity',
        )
        replayed_message = self._get_activity_done_messages(lead, self.todo_type)
        online_message = self._get_activity_done_messages(online_lead, self.todo_type)
        self.assertEqual(len(online_message), 1)
        for fname in ('message_type', 'subtype_id', 'mail_activity_type_id', 'author_id', 'body', 'attachment_ids'):
            self.assertEqual(replayed_message[fname], online_message[fname], f'Replayed and online Mark Done differ on message {fname}')
        for fname in ('activity_ids', 'activity_state', 'activity_date_deadline', 'activity_type_id'):
            self.assertEqual(lead[fname], online_lead[fname], f'Replayed and online Mark Done differ on lead {fname}')

    def _activity_call_vals(self, user, lead, summary='Call'):
        """ The values of the ``mail.activity`` ``create`` the CRM activity sheet
        sends for "Log a call" on ``lead``, assigned to ``user``, JSON-serialized:
        the lead named by ``res_model`` only, the deadline a "YYYY-MM-DD" string. """
        return {
            'res_model': 'crm.lead',
            'res_id': lead.id,
            'activity_type_id': self.call_type.id,
            'summary': summary,
            'date_deadline': fields.Date.to_string(fields.Date.today()),
            'user_id': user.id,
        }

    def _log_call(self, user, lead, key, summary='Call', **context):
        """ Deliver, as ``user``, the call the CRM activity sheet sends for "Log a
        call", online or replayed from the offline queue: ``mail.activity``
        ``create`` of one value with the scheduled activity's delivery key
        (``crm_offline_create_key``) plus ``context`` in its context.

        :return: the ``create`` answer, a ``mail.activity`` record
        """
        return self.env['mail.activity'].with_user(user).with_context(crm_offline_create_key=key, **context).create(
            [self._activity_call_vals(user, lead, summary)],
        )

    def _lead_activities(self, lead):
        """ Every activity of ``lead``, done (archived) ones included. """
        return self.env['mail.activity'].with_context(active_test=False).search([
            ('res_model', '=', 'crm.lead'), ('res_id', '=', lead.id),
        ])

    def _refused_delivery(self, exception_class, deliver, *args, **kwargs):
        """ Call ``deliver(*args, **kwargs)`` and assert it raises
        ``exception_class``. Unlike ``assertRaises``, no savepoint is rolled back
        on the error, so whatever the delivery changed before being refused
        stays visible to the assertions that it changed nothing.

        :return: the exception raised
        """
        try:
            deliver(*args, **kwargs)
        except exception_class as error:
            return error
        raise self.failureException(f'The delivery was not refused with {exception_class.__name__}')

    def test_offline_activity_create_replay_same_key_creates_once(self):
        """ "Log a call" whose answer was lost (the server created the activity,
        then the connection dropped) is sent again verbatim with the same
        delivery key: replayed again from the queue, or queued by the online
        create whose answer was lost and replayed. The server answers with the
        activity the first delivery created and creates nothing: one activity
        per scheduled activity. Through the web client's JSON-RPC route, both
        deliveries answer the same id. A done (archived) activity is still the
        delivered one; a deleted one takes its key with it. """
        salesman = self.user_sales_salesman
        lead = self._create_salesman_opportunity('Lost Answer Activity Lead')
        key = secrets.token_hex(16)

        first = self._log_call(salesman, lead, key)
        self.assertEqual(len(first), 1)
        self.assertEqual(self._lead_activities(lead), first)
        self.assertEqual((first.create_uid, first.user_id, first.summary), (salesman, salesman, 'Call'))
        self.assertEqual(first.activity_type_id, self.call_type)
        # ir.model is not readable by salespersons: the link is read as superuser
        self.assertEqual(first.sudo().res_model_id.model, 'crm.lead')
        self.assertIn(first, lead.with_user(salesman).activity_ids)
        xmlid = self._quick_create_xmlids(key)
        self.assertEqual(len(xmlid), 1)
        self.assertEqual(
            (xmlid.model, xmlid.res_id, xmlid.noupdate, xmlid.complete_name),
            ('mail.activity', first.id, True, f'__crm_offline__.{key}'),
        )
        self.assertEqual(self.env.ref(f'__crm_offline__.{key}'), first)
        lead.invalidate_recordset(['message_ids', 'message_follower_ids'])
        messages, followers = lead.message_ids, lead.message_follower_ids

        # delivered again, twice: the same activity, nothing created or posted
        for _delivery in range(2):
            self.assertEqual(self._log_call(salesman, lead, key), first)
        self.assertEqual(self._lead_activities(lead), first)
        self.assertEqual(self.env['mail.activity'].with_context(active_test=False).search_count([('summary', '=', 'Call'), ('res_id', '=', lead.id)]), 1)
        self.assertEqual(self._quick_create_xmlids(key), xmlid)
        lead.invalidate_recordset(['message_ids', 'message_follower_ids'])
        self.assertEqual(lead.message_ids, messages, 'A repeated delivery posts nothing')
        self.assertEqual(lead.message_follower_ids, followers, 'A repeated delivery subscribes nobody')

        # the web client's JSON-RPC route: the call the sheet sends online, then
        # the same call replayed from the queue (with the id of its user)
        self.authenticate(salesman.login, salesman.login)
        route_key = secrets.token_hex(16)
        call = {
            'model': 'mail.activity',
            'method': 'create',
            'args': [[self._activity_call_vals(salesman, lead, 'Route Call')]],
            'kwargs': {'context': {'uid': salesman.id, 'crm_offline_create_key': route_key}},
        }
        delivered = self.make_jsonrpc_request('/web/dataset/call_kw/mail.activity/create', call)
        replayed_call = copy.deepcopy(call)
        replayed_call['kwargs']['context']['crm_offline_uid'] = salesman.id
        redelivered = self.make_jsonrpc_request('/web/dataset/call_kw/mail.activity/create', replayed_call)
        route_activity = self._lead_activities(lead) - first
        self.assertEqual(len(route_activity), 1)
        self.assertEqual(delivered, route_activity.ids)
        self.assertEqual(redelivered, delivered)
        self.assertEqual((route_activity.create_uid, route_activity.summary), (salesman, 'Route Call'))
        self.assertEqual(self._quick_create_xmlids(route_key).res_id, route_activity.id)

        # marked done (archived): still the delivered activity
        first.with_user(salesman).action_done()
        self.assertTrue(first.exists())
        self.assertFalse(first.active)
        self.assertEqual(self._log_call(salesman, lead, key), first)
        self.assertEqual(self._lead_activities(lead), first | route_activity)

        # deleted: its external identifier goes, and the key creates it again
        first.sudo().unlink()
        self.assertFalse(self._quick_create_xmlids(key))
        recreated = self._log_call(salesman, lead, key)
        self.assertNotEqual(recreated.id, first.id)
        self.assertEqual(self._lead_activities(lead), recreated | route_activity)
        self.assertEqual(self._quick_create_xmlids(key).res_id, recreated.id)

        # an external identifier left behind by an activity deleted without the
        # ORM is taken over by the next delivery of its key
        self.env.cr.execute('DELETE FROM mail_activity WHERE id = %s', [recreated.id])
        self.env['mail.activity'].invalidate_model()
        taken_over = self._log_call(salesman, lead, key)
        self.assertNotIn(taken_over.id, (first.id, recreated.id))
        self.assertEqual(self._quick_create_xmlids(key).res_id, taken_over.id)
        self.assertEqual(self._log_call(salesman, lead, key), taken_over)
        self.assertEqual(self._lead_activities(lead), taken_over | route_activity)

    def test_offline_activity_create_replay_key_refused(self):
        """ A delivery key registered by another user's activity create, or by a
        lead create, is refused: no activity is returned or created. A keyed
        create whose context ``uid`` names another user than the caller (one
        user's queued create replayed in the session of the next user of a
        shared browser) is refused before its key is looked up, and creates and
        registers nothing; delivered by the user it names, it creates its
        activity once. """
        salesman, other = self.user_sales_salesman, self.user_sales_leads
        lead = self._create_salesman_opportunity('Foreign Key Activity Lead')

        key = secrets.token_hex(16)
        foreign = self._log_call(other, lead, key)
        self.assertEqual(foreign.create_uid, other)
        with self.assertRaises(AccessError) as refused:
            self._log_call(salesman, lead, key)
        # sent by its own user: the web client keeps it parked, it is not replayed again
        self.assertNotIsInstance(refused.exception, CrmOfflineOriginError)
        self.assertEqual(refused.exception.args[0], 'This activity was already created by another user.')
        self.assertEqual(self._lead_activities(lead), foreign)
        self.assertEqual(self._quick_create_xmlids(key).res_id, foreign.id)

        # the key of a lead created by the mobile quick create names no activity
        lead_key = secrets.token_hex(16)
        [quick] = self._quick_create(salesman, {
            'name': 'Quick Key Lead',
            'contact_name': '',
            'phone': '',
            'email_from': '',
            'expected_revenue': 0.0,
            'stage_id': self.stage_gen_1.id,
        }, lead_key)
        with self.assertRaises(AccessError) as refused:
            self._log_call(salesman, lead, lead_key)
        self.assertNotIsInstance(refused.exception, CrmOfflineOriginError)
        self.assertEqual(self._lead_activities(lead), foreign)
        self.assertEqual(
            (self._quick_create_xmlids(lead_key).model, self._quick_create_xmlids(lead_key).res_id),
            ('crm.lead', quick['id']),
        )

        # queued by another user than the caller: refused, nothing registered
        origin_key = secrets.token_hex(16)
        with self._assert_queued_by_another_user():
            self._log_call(salesman, lead, origin_key, uid=other.id)
        self.assertEqual(self._lead_activities(lead), foreign)
        self.assertFalse(self._quick_create_xmlids(origin_key))

        # delivered by the user who queued it: created once
        own = self._log_call(salesman, lead, origin_key, uid=salesman.id)
        self.assertEqual(own.create_uid, salesman)
        self.assertEqual(self._log_call(salesman, lead, origin_key, uid=salesman.id), own)
        self.assertEqual(self._lead_activities(lead), foreign | own)
        self.assertEqual(self._quick_create_xmlids(origin_key).res_id, own.id)

        # a later delivery naming another user is refused before the key is looked up
        with self._assert_queued_by_another_user():
            self._log_call(salesman, lead, origin_key, uid=other.id)
        with self._assert_queued_by_another_user():
            self._log_call(other, lead, origin_key, uid=salesman.id)
        # a boolean is no user id: the delivery is checked as without one
        self.assertEqual(self._log_call(salesman, lead, origin_key, uid=False), own)
        self.assertEqual(self._lead_activities(lead), foreign | own)

    def test_offline_activity_create_replay_access_revoked(self):
        """ A repeated delivery of a key is answered with its activity only while
        its creator may still create that activity, its lead included, and read
        it, as its first delivery required. Once they may not (read revoked, the
        lead reassigned, then the activity too), it is refused with an
        ``AccessError``, neither the refusal of a call queued by another user
        nor of a key registered by another user, through the ORM and the web
        client's JSON-RPC route alike, and creates and registers nothing. With
        the access restored, it answers that activity again. """
        salesman, other = self.user_sales_salesman, self.user_sales_leads
        lead = self._create_salesman_opportunity('Revoked Access Activity Lead')
        key = secrets.token_hex(16)
        first = self._log_call(salesman, lead, key)
        xmlid = self._quick_create_xmlids(key)
        self.assertEqual(xmlid.res_id, first.id)

        def caller_access(operation):
            # as a request of its own sees it: no field or access value cached earlier
            self.env.invalidate_all()
            self.env.transaction.invalidate_access_cache()
            return first.with_user(salesman).has_access(operation)

        def assert_redelivery_refused():
            error = self._refused_delivery(AccessError, self._log_call, salesman, lead, key)
            self.assertNotIsInstance(error, CrmOfflineOriginError)
            self.assertNotEqual(error.args[0], 'This activity was already created by another user.')
            self.assertEqual(self._lead_activities(lead), first)
            self.assertEqual(self._quick_create_xmlids(key), xmlid)
            self.assertEqual(xmlid.res_id, first.id)

        # read revoked on that activity (an administrator's restriction), its lead still the caller's
        restriction = self.env['ir.access'].create({
            'name': 'Delivered activity hidden',
            'model_id': self.env['ir.model']._get_id('mail.activity'),
            'operation': 'r',
            'domain': f"[('id', '!=', {first.id})]",
        })
        self.assertEqual((caller_access('create'), caller_access('read')), (True, False))
        assert_redelivery_refused()
        restriction.unlink()
        self.assertEqual((caller_access('create'), caller_access('read')), (True, True))
        self.assertEqual(self._log_call(salesman, lead, key), first)

        # the lead reassigned: its activities can no longer be created by the
        # caller, who still reads the activity assigned to them
        lead.user_id = other
        self.assertEqual(first.user_id, salesman)
        self.assertEqual((caller_access('create'), caller_access('read')), (False, True))
        assert_redelivery_refused()

        # the activity reassigned too: the caller may neither create nor read it
        first.with_env(self.env).user_id = other
        self.assertEqual((caller_access('create'), caller_access('read')), (False, False))
        assert_redelivery_refused()

        # the web client's JSON-RPC route: refused, the activity's id is not answered
        self.authenticate(salesman.login, salesman.login)
        call = {
            'model': 'mail.activity',
            'method': 'create',
            'args': [[self._activity_call_vals(salesman, lead)]],
            'kwargs': {'context': {'uid': salesman.id, 'crm_offline_uid': salesman.id, 'crm_offline_create_key': key}},
        }
        with self.assertRaises(JsonRpcException) as refused, mute_logger('odoo.http'):
            self.make_jsonrpc_request('/web/dataset/call_kw/mail.activity/create', call)
        # the JSON-RPC error's data.name
        self.assertEqual(refused.exception.args[0], 'odoo.exceptions.AccessError')
        self.assertEqual(self._lead_activities(lead), first)
        self.assertEqual(self._quick_create_xmlids(key), xmlid)

        # the lead given back: the caller may create its activities and read them
        # through it, so the delivery answers the activity again, creating nothing
        lead.user_id = salesman
        self.assertEqual((caller_access('create'), caller_access('read')), (True, True))
        self.assertEqual(self._log_call(salesman, lead, key), first)
        self.assertEqual(self.make_jsonrpc_request('/web/dataset/call_kw/mail.activity/create', call), [first.id])
        self.assertEqual(self._lead_activities(lead), first)
        self.assertEqual(self._quick_create_xmlids(key), xmlid)
        self.assertEqual(xmlid.res_id, first.id)

    def test_offline_activity_create_replay_invalid_key(self):
        """ A delivery key names one scheduled activity. A supplied key that is
        not 32 lowercase hexadecimal digits, or a valid key sent with the values
        of no or several activities, is refused with a ``UserError`` at every
        delivery, before anything is created or registered: repeated, it
        duplicates nothing. Without a key (no context key, or one left unset:
        ``None`` or ``False``), an activity create is a plain create: every
        delivery creates its activity, and no external identifier is
        registered. """
        salesman = self.user_sales_salesman
        lead = self._create_salesman_opportunity('Unkeyed Activity Lead')
        registered = self.env['ir.model.data'].search([('module', '=', '__crm_offline__')])
        # fixed, with letters, so that its upper-case variant is not a valid key
        hex_key = '0123456789abcdef' * 2
        invalid_keys = [
            hex_key.upper(), hex_key[:-1], hex_key + '0', f'{hex_key[:-1]}g', f' {hex_key}',
            f'{hex_key}\n', int(hex_key, 16), '',
        ]
        for key in invalid_keys:
            with self.subTest(key=key):
                for _delivery in range(2):
                    refused = self._refused_delivery(UserError, self._log_call, salesman, lead, key)
                    self.assertEqual(
                        refused.args[0],
                        'This activity was not created: its delivery key is not 32 lowercase hexadecimal digits.',
                    )
                self.assertFalse(self._lead_activities(lead))
        self.assertEqual(self.env['ir.model.data'].search([('module', '=', '__crm_offline__')]), registered)
        self.assertFalse(self.env['ir.model.data'].search([('module', '=', '__crm_offline__'), ('name', 'ilike', hex_key[:-1])]))

        # without a key: a context key left unset, or none
        for key in (None, False):
            with self.subTest(key=key):
                for _delivery in range(2):
                    self._log_call(salesman, lead, key)
        for _delivery in range(2):
            self.env['mail.activity'].with_user(salesman).create([self._activity_call_vals(salesman, lead)])
        activities = self._lead_activities(lead)
        self.assertEqual(len(activities), 6)
        self.assertEqual(set(activities.mapped('summary')), {'Call'})
        self.assertEqual(activities.sudo().res_model_id.mapped('model'), ['crm.lead'])
        self.assertFalse(self.env['ir.model.data'].search([('model', '=', 'mail.activity'), ('res_id', 'in', activities.ids)]))
        self.assertEqual(self.env['ir.model.data'].search([('module', '=', '__crm_offline__')]), registered)

        # a valid key sent with the values of several activities, or of none
        batch_key = secrets.token_hex(16)
        Activity = self.env['mail.activity'].with_user(salesman).with_context(crm_offline_create_key=batch_key)
        batch = [
            self._activity_call_vals(salesman, lead, 'Batch Call'),
            self._activity_call_vals(salesman, lead, 'Batch Follow-up'),
        ]
        for vals_list in (batch, []):
            with self.subTest(values=len(vals_list)):
                for _delivery in range(2):
                    refused = self._refused_delivery(UserError, Activity.create, copy.deepcopy(vals_list))
                    self.assertEqual(
                        refused.args[0],
                        'These activities were not created: a delivery key is sent with the values of exactly one activity.',
                    )
        self.assertEqual(self._lead_activities(lead), activities)
        self.assertFalse(self._quick_create_xmlids(batch_key))
        self.assertEqual(self.env['ir.model.data'].search([('module', '=', '__crm_offline__')]), registered)

    def test_offline_activity_create_replay_concurrent_delivery(self):
        """ A delivery whose lookup does not see the key a concurrent delivery
        registered (another tab replaying the same queued create, its
        registration committed after this delivery's snapshot) creates an
        activity it cannot register the key for. It is rolled back with that
        activity and retried by the RPC layer, and the retry answers with the
        activity the first delivery created: no error reaches the web client,
        which would park a create that succeeded. The lookup of the first
        attempt is made blind to the registration, which happens in the same
        transaction, so the retry is deterministic. """
        salesman = self.user_sales_salesman
        lead = self._create_salesman_opportunity('Concurrent Activity Lead')
        key = secrets.token_hex(16)
        first = self._log_call(salesman, lead, key)
        self.assertEqual(self._quick_create_xmlids(key).res_id, first.id)

        IrModelData = self.registry['ir.model.data']
        search = IrModelData.search
        key_domain = [('module', '=', '__crm_offline__'), ('name', '=', key)]
        blind_lookups = []

        def search_blind_once(records, domain, *args, **kwargs):
            if domain == key_domain and not blind_lookups:
                blind_lookups.append(domain)
                return records.browse()
            return search(records, domain, *args, **kwargs)

        self.authenticate(salesman.login, salesman.login)
        call = {
            'model': 'mail.activity',
            'method': 'create',
            'args': [[self._activity_call_vals(salesman, lead)]],
            'kwargs': {'context': {'uid': salesman.id, 'crm_offline_uid': salesman.id, 'crm_offline_create_key': key}},
        }
        with patch.object(IrModelData, 'search', search_blind_once):
            redelivered = self.make_jsonrpc_request('/web/dataset/call_kw/mail.activity/create', call)
        self.assertEqual(blind_lookups, [key_domain], 'The first attempt did not see the registration')
        self.assertEqual(redelivered, [first.id], 'The retry answers with the activity the first delivery created')
        self.assertEqual(
            self._lead_activities(lead), first,
            'The activity of the attempt that could not register the key was rolled back',
        )
        self.assertEqual(self._quick_create_xmlids(key).res_id, first.id)

    def test_offline_quick_create_replay(self):
        """ The mobile quick create queues ``web_save [[], vals]`` with the six
        fields it captures and ``{context: <pipeline list context>,
        specification: {}}``. The server fills the rest at replay, with the
        pipeline's ``default_type``, so the lead stays in the opportunity-only
        pipeline. The replayed lead must match a twin quick create saved online,
        which reads its fields back. """
        salesman = self.user_sales_salesman
        vals = {
            'name': 'Quick Offline Lead',
            'contact_name': 'Quick Contact',
            'phone': '+32 494 55 55 55',
            'email_from': 'quick@example.com',
            'expected_revenue': 777.0,
            'stage_id': self.stage_gen_1.id,
        }
        self.assertEqual(len(vals), 6)
        self.assertEqual(self.pipeline_context.get('default_type'), 'opportunity')

        result = self.env['crm.lead'].with_user(salesman).with_context(self.pipeline_context).browse().web_save(
            vals, specification={},
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(set(result[0]), {'id'})

        lead = self.env['crm.lead'].with_user(salesman).browse(result[0]['id'])
        self.assertEqual(lead.type, 'opportunity')
        self.assertEqual(lead.stage_id, self.stage_gen_1)
        for fname, value in vals.items():
            with self.subTest(field=fname):
                self.assertEqual(lead[fname].id if fname == 'stage_id' else lead[fname], value)
        self.assertEqual(lead.user_id, salesman, 'The server default assigns the lead to its creator')

        self.assertEqual(
            self.env['crm.lead'].with_user(salesman).search(self.pipeline_domain + [('id', '=', lead.id)]),
            lead,
            'The created lead is listed by the pipeline action',
        )

        # online twin: the same values saved online, with the fields read back
        online_result = self.env['crm.lead'].with_user(salesman).with_context(self.pipeline_context).browse().web_save(
            dict(vals, name='Quick Online Lead'), specification={
                'name': {},
                'contact_name': {},
                'phone': {},
                'email_from': {},
                'expected_revenue': {},
                'stage_id': {'fields': {'display_name': {}}},
                'type': {},
                'user_id': {'fields': {'display_name': {}}},
            },
        )
        self.assertEqual(len(online_result), 1)
        online_lead = self.env['crm.lead'].with_user(salesman).browse(online_result[0]['id'])
        self.assertNotEqual(online_lead, lead)
        self.assertEqual(online_result, [{
            'id': online_lead.id,
            'name': 'Quick Online Lead',
            'contact_name': 'Quick Contact',
            'phone': '+32 494 55 55 55',
            'email_from': 'quick@example.com',
            'expected_revenue': 777.0,
            'stage_id': {'id': self.stage_gen_1.id, 'display_name': self.stage_gen_1.display_name},
            'type': 'opportunity',
            'user_id': {'id': salesman.id, 'display_name': salesman.display_name},
        }])
        for fname in (
            'type', 'stage_id', 'user_id', 'team_id', 'company_id', 'probability', 'contact_name',
            'phone', 'email_from', 'expected_revenue', 'active', 'partner_id',
        ):
            self.assertEqual(lead[fname], online_lead[fname], f'Replayed and online quick creates differ on {fname}')
        self.assertEqual(
            self.env['crm.lead'].with_user(salesman).search(self.pipeline_domain + [('id', 'in', (lead + online_lead).ids)]),
            lead + online_lead,
            'The pipeline action lists the replayed and the online lead alike',
        )

    def _quick_create(self, user, vals, key, specification=None, next_id=None, later_save=None):
        """ Deliver the call the mobile quick create sends, online or replayed from
        the offline queue: ``web_save([], vals)`` with the pipeline context and the
        create's delivery key, as ``user``. ``later_save`` (when not ``None``) is
        sent as the ``crm_offline_create_write`` flag a lead form adds to a later
        save of its still-new lead.

        :return: the ``web_save`` answer
        """
        context = dict(self.pipeline_context, crm_offline_create_key=key)
        if later_save is not None:
            context['crm_offline_create_write'] = later_save
        return self.env['crm.lead'].with_user(user).with_context(context).browse().web_save(
            vals, specification={} if specification is None else specification, next_id=next_id,
        )

    def _quick_create_xmlids(self, key):
        """ The external identifiers a delivery key is registered under. """
        return self.env['ir.model.data'].search([('module', '=', '__crm_offline__'), ('name', '=', key)])

    def test_offline_quick_create_replay_same_key_creates_once(self):
        """ A quick create whose answer was lost is sent again verbatim, with the
        same delivery key: the server answers with the lead the first delivery
        created and creates nothing. A repeated delivery writes nothing, other
        values included; one flagged as a later save of the still-new lead
        (``crm_offline_create_write``) writes its values there. """
        salesman = self.user_sales_salesman
        key = secrets.token_hex(16)
        vals = {
            'name': 'Lost Answer Lead',
            'contact_name': 'Lost Contact',
            'phone': '+32 494 66 66 66',
            'email_from': 'lost@example.com',
            'expected_revenue': 300.0,
            'stage_id': self.stage_gen_1.id,
        }
        first = self._quick_create(salesman, vals, key)
        self.assertEqual(len(first), 1)
        self.assertEqual(set(first[0]), {'id'})
        lead = self.env['crm.lead'].browse(first[0]['id'])
        self.assertEqual(lead.type, 'opportunity')
        self.assertEqual(lead.create_uid, salesman)
        messages = lead.message_ids

        # the same call again (the replay): the first delivery's lead answers it,
        # unchanged
        self.assertEqual(self._quick_create(salesman, dict(vals), key), first)
        self.assertEqual(lead.message_ids, messages, 'A repeated delivery of the same values changes nothing')
        # then with other values: the first delivery's lead answers it, unchanged
        self.assertEqual(self._quick_create(salesman, dict(vals, expected_revenue=999.0, name='Other'), key), first)
        self.assertEqual((lead.name, lead.expected_revenue), ('Lost Answer Lead', 300.0))
        # flagged as a later save of the still-new lead: written there
        self.assertEqual(
            self._quick_create(salesman, dict(vals, expected_revenue=999.0, name='Other'), key, later_save=True), first,
        )
        self.assertEqual((lead.name, lead.expected_revenue), ('Other', 999.0))
        self.assertEqual(
            self._quick_create(salesman, vals, key, specification={'name': {}, 'expected_revenue': {}}, later_save=True),
            [{'id': lead.id, 'name': 'Lost Answer Lead', 'expected_revenue': 300.0}],
            'A delivery reading fields back reads them from the delivered lead, as it wrote them',
        )
        leads = self.env['crm.lead'].with_context(active_test=False).search([('name', 'in', ('Lost Answer Lead', 'Other'))])
        self.assertEqual(leads, lead, 'Every delivery of one key makes one lead')
        for fname, value in vals.items():
            with self.subTest(field=fname):
                self.assertEqual(lead[fname].id if fname == 'stage_id' else lead[fname], value)

        # an archived lead is still the delivered one
        lead.action_archive()
        self.assertEqual(self._quick_create(salesman, vals, key), first)
        self.assertEqual(self.env['crm.lead'].with_context(active_test=False).search_count([('name', '=', 'Lost Answer Lead')]), 1)

        # `next_id` answers that record, as base web_save does, for a first
        # delivery and a repeated one alike
        other = self._create_salesman_opportunity('Next Lead')
        self.assertEqual(self._quick_create(salesman, vals, key, next_id=other.id), [{'id': other.id}])
        next_key = secrets.token_hex(16)
        self.assertEqual(
            self._quick_create(salesman, dict(vals, name='Next Key Lead'), next_key, specification={'name': {}}, next_id=other.id),
            [{'id': other.id, 'name': 'Next Lead'}],
        )
        next_key_lead = self.env['crm.lead'].search([('name', '=', 'Next Key Lead')])
        self.assertEqual(len(next_key_lead), 1)
        self.assertEqual(self._quick_create_xmlids(next_key).res_id, next_key_lead.id)

    def test_offline_quick_create_retry_keeps_later_save(self):
        """ A keyed quick create whose answer was lost stays queued while its
        creator saves the lead by its id (in another tab, online). Sent again
        verbatim, the create answers with that lead and creates and writes
        nothing: the later save keeps its values and no message is posted. A
        flag other than ``True`` is no later-save flag. Only a delivery flagged
        as a later save of the still-new lead (``crm_offline_create_write``)
        writes its values, under the caller's context without the key and the
        flag; a flagged first delivery creates the lead with the same context. """
        salesman = self.user_sales_salesman
        key = secrets.token_hex(16)
        vals = {
            'name': 'Retried Lead',
            'contact_name': 'Retried Contact',
            'phone': '+32 494 77 77 77',
            'email_from': 'retried@example.com',
            'expected_revenue': 100.0,
            'stage_id': self.stage_gen_1.id,
        }
        first = self._quick_create(salesman, vals, key)
        lead = self.env['crm.lead'].browse(first[0]['id'])
        # the creator's later save, by the lead's id
        lead.with_user(salesman).web_save({'name': 'Saved Since', 'expected_revenue': 200.0}, specification={})
        self.assertEqual((lead.name, lead.expected_revenue), ('Saved Since', 200.0))
        messages = lead.message_ids

        CrmLead = self.registry['crm.lead']
        write, create = CrmLead.write, CrmLead.create
        calls = []

        def record_write(records, vals):
            calls.append(('write', records.ids, dict(records.env.context)))
            return write(records, vals)

        def record_create(records, vals_list):
            calls.append(('create', dict(records.env.context)))
            return create(records, vals_list)

        with patch.object(CrmLead, 'write', record_write), patch.object(CrmLead, 'create', record_create):
            self.assertEqual(self._quick_create(salesman, dict(vals), key), first)
            self.assertEqual(
                self._quick_create(salesman, dict(vals), key, specification={'name': {}, 'expected_revenue': {}}),
                [{'id': lead.id, 'name': 'Saved Since', 'expected_revenue': 200.0}],
                'The retry reads the lead back as the later save left it',
            )
            for flag in (False, 'true', 'True', '1', [True], {'write': True}):
                with self.subTest(flag=flag):
                    self.assertEqual(self._quick_create(salesman, dict(vals), key, later_save=flag), first)
        self.assertEqual(calls, [], 'A repeated delivery creates and writes nothing')
        self.assertEqual((lead.name, lead.expected_revenue), ('Saved Since', 200.0))
        self.assertEqual(lead.message_ids, messages, 'A repeated delivery posts nothing')

        # a later save of the still-new lead, flagged: written on the delivered lead
        with patch.object(CrmLead, 'write', record_write), patch.object(CrmLead, 'create', record_create):
            self.assertEqual(
                self._quick_create(salesman, dict(vals, name='Later Save', expected_revenue=300.0), key, later_save=True),
                first,
            )
        self.assertEqual([call[:2] for call in calls], [('write', lead.ids)])
        written_context = calls[0][2]
        self.assertNotIn('crm_offline_create_key', written_context)
        self.assertNotIn('crm_offline_create_write', written_context)
        self.assertEqual(written_context['default_type'], 'opportunity')
        self.assertEqual((lead.name, lead.expected_revenue), ('Later Save', 300.0))
        self.assertEqual(
            self.env['crm.lead'].with_context(active_test=False).search(
                [('name', 'in', ('Retried Lead', 'Saved Since', 'Later Save'))],
            ),
            lead,
            'Every delivery of one key makes one lead',
        )
        self.assertEqual(len(self._quick_create_xmlids(key)), 1)
        self.assertEqual(self._quick_create_xmlids(key).res_id, lead.id)

        # a flagged first delivery (a create queued again with later values before
        # any delivery reached the server) creates the lead and registers its key
        calls.clear()
        flagged_key = secrets.token_hex(16)
        with patch.object(CrmLead, 'create', record_create):
            [created] = self._quick_create(salesman, dict(vals, name='Flagged First'), flagged_key, later_save=True)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('crm_offline_create_key', calls[0][1])
        self.assertNotIn('crm_offline_create_write', calls[0][1])
        flagged_lead = self.env['crm.lead'].search([('name', '=', 'Flagged First')])
        self.assertEqual(flagged_lead.ids, [created['id']])
        self.assertEqual(self._quick_create_xmlids(flagged_key).res_id, flagged_lead.id)

    def test_offline_quick_create_replay_distinct_keys(self):
        """ Two quick creates carry two delivery keys: identical values still make
        two leads, so a create is never answered with another create's lead. """
        salesman = self.user_sales_salesman
        vals = {
            'name': 'Twin Lead',
            'contact_name': '',
            'phone': '',
            'email_from': '',
            'expected_revenue': 30.0,
            'stage_id': self.stage_gen_1.id,
        }
        first_key, second_key = secrets.token_hex(16), secrets.token_hex(16)
        self.assertNotEqual(first_key, second_key)
        first = self._quick_create(salesman, vals, first_key)
        second = self._quick_create(salesman, dict(vals), second_key)
        self.assertNotEqual(first, second)
        twins = self.env['crm.lead'].search([('name', '=', 'Twin Lead')])
        self.assertEqual(set(twins.ids), {first[0]['id'], second[0]['id']})
        self.assertEqual(len(twins), 2)
        self.assertEqual(self._quick_create_xmlids(first_key).res_id, first[0]['id'])
        self.assertEqual(self._quick_create_xmlids(second_key).res_id, second[0]['id'])

        # each key answers with its own lead
        self.assertEqual(self._quick_create(salesman, vals, second_key), second)
        self.assertEqual(self._quick_create(salesman, vals, first_key), first)
        self.assertEqual(self.env['crm.lead'].search_count([('name', '=', 'Twin Lead')]), 2)

    def test_offline_quick_create_replay_concurrent_delivery(self):
        """ A delivery whose lookup does not see the key a concurrent delivery
        registered (a registration committed after its snapshot) creates a lead
        it cannot register the key for. It is rolled back with that lead and
        retried by the RPC layer, and the retry answers with the lead the first
        delivery created: no error reaches the web client, which would park a
        create that succeeded, and none is logged. The lookup of the first
        attempt is made blind to the registration, which happens in the same
        transaction, so the retry is deterministic. """
        salesman = self.user_sales_salesman
        key = secrets.token_hex(16)
        vals = {
            'name': 'Concurrent Delivery Lead',
            'contact_name': '',
            'phone': '',
            'email_from': '',
            'expected_revenue': 20.0,
            'stage_id': self.stage_gen_1.id,
        }
        first = self._quick_create(salesman, vals, key)
        lead = self.env['crm.lead'].browse(first[0]['id'])
        self.assertEqual(self._quick_create_xmlids(key).res_id, lead.id)

        IrModelData = self.registry['ir.model.data']
        search = IrModelData.search
        key_domain = [('module', '=', '__crm_offline__'), ('name', '=', key)]
        blind_lookups = []

        def search_blind_once(records, domain, *args, **kwargs):
            if domain == key_domain and not blind_lookups:
                blind_lookups.append(domain)
                return records.browse()
            return search(records, domain, *args, **kwargs)

        self.authenticate(salesman.login, salesman.login)
        call = {
            'model': 'crm.lead',
            'method': 'web_save',
            'args': [[], vals],
            'kwargs': {
                'context': dict(self.pipeline_context, crm_offline_create_key=key, uid=salesman.id),
                'specification': {},
            },
        }
        with patch.object(IrModelData, 'search', search_blind_once):
            redelivered = self.make_jsonrpc_request('/web/dataset/call_kw/crm.lead/web_save', call)
        self.assertEqual(blind_lookups, [key_domain], 'The first attempt did not see the registration')
        self.assertEqual(redelivered, first, 'The retry answers with the lead the first delivery created')
        self.assertEqual(
            self.env['crm.lead'].with_context(active_test=False).search([('name', '=', vals['name'])]), lead,
            'The lead of the attempt that could not register the key was rolled back',
        )
        self.assertEqual(self._quick_create_xmlids(key).res_id, lead.id)

    def test_offline_quick_create_replay_key_of_another_user(self):
        """ A delivery key registered by another user's create is refused: the
        lead is neither returned nor created again. """
        key = secrets.token_hex(16)
        vals = {
            'name': 'Foreign Key Lead',
            'contact_name': '',
            'phone': '',
            'email_from': '',
            'expected_revenue': 0.0,
            'stage_id': self.stage_gen_1.id,
        }
        [foreign] = self._quick_create(self.user_sales_leads, vals, key)
        with self.assertRaises(AccessError) as refused:
            self._quick_create(self.user_sales_salesman, vals, key)
        # sent by its own user: the web client keeps it parked, it is not replayed again
        self.assertNotIsInstance(refused.exception, CrmOfflineOriginError)
        leads = self.env['crm.lead'].with_context(active_test=False).search([('name', '=', 'Foreign Key Lead')])
        self.assertEqual(leads.ids, [foreign['id']])
        self.assertEqual(leads.create_uid, self.user_sales_leads)
        self.assertEqual(self._quick_create_xmlids(key).res_id, foreign['id'])

    def test_offline_quick_create_replay_queued_by_another_user(self):
        """ A browser shared by two users keeps one offline queue: a create one
        user queued must not be delivered in the session of the next one. Its
        context names the user who queued it (``uid``, sent by the web client
        with every call), so a first delivery by another user is refused, and
        creates and registers nothing. Delivered by the user it names, the same
        create makes its lead once. """
        salesman, other = self.user_sales_salesman, self.user_sales_leads
        key = secrets.token_hex(16)
        vals = {
            'name': 'Queued Elsewhere Lead',
            'contact_name': 'Queued Contact',
            'phone': '',
            'email_from': '',
            'expected_revenue': 40.0,
            'stage_id': self.stage_gen_1.id,
        }

        def deliver(user, origin_uid):
            context = dict(self.pipeline_context, crm_offline_create_key=key, uid=origin_uid)
            return self.env['crm.lead'].with_user(user).with_context(context).browse().web_save(
                vals, specification={},
            )

        def created_leads():
            return self.env['crm.lead'].with_context(active_test=False).search([('name', '=', vals['name'])])

        with self.assertRaises(CrmOfflineOriginError):
            deliver(salesman, other.id)
        self.assertFalse(created_leads())
        self.assertFalse(self._quick_create_xmlids(key))

        # the same call through the web client's JSON-RPC route, whose context
        # reaches the save as sent: refused as well, under the error name the
        # web client parks the call with
        self.authenticate(salesman.login, salesman.login)
        call = {
            'model': 'crm.lead',
            'method': 'web_save',
            'args': [[], vals],
            'kwargs': {
                'context': dict(self.pipeline_context, crm_offline_create_key=key, uid=other.id),
                'specification': {},
            },
        }
        with self.assertRaises(JsonRpcException) as refused, mute_logger('odoo.http'):
            self.make_jsonrpc_request('/web/dataset/call_kw/crm.lead/web_save', call)
        # the JSON-RPC error's data.name
        self.assertEqual(refused.exception.args[0], 'odoo.addons.crm.models.crm_lead.CrmOfflineOriginError')
        self.assertFalse(created_leads())
        self.assertFalse(self._quick_create_xmlids(key))

        # delivered by the user who queued it, through the route and again directly
        call['kwargs']['context']['uid'] = salesman.id
        first = self.make_jsonrpc_request('/web/dataset/call_kw/crm.lead/web_save', call)
        lead = created_leads()
        self.assertEqual(first, [{'id': lead.id}])
        self.assertEqual((lead.create_uid, lead.user_id), (salesman, salesman))
        self.assertEqual(self._quick_create_xmlids(key).res_id, lead.id)
        self.assertEqual(deliver(salesman, salesman.id), first)
        self.assertEqual(created_leads(), lead, 'Every delivery of one key makes one lead')

        # a later delivery naming another user is refused before the key is looked up
        with self.assertRaises(CrmOfflineOriginError):
            deliver(salesman, other.id)
        with self.assertRaises(CrmOfflineOriginError):
            deliver(other, salesman.id)
        # a boolean is no user id: the delivery is checked as without one
        self.assertEqual(deliver(salesman, False), first)
        self.assertEqual(created_leads(), lead)

    def test_offline_quick_create_replay_invalid_key(self):
        """ Without a well-formed delivery key, a create is a plain create: every
        delivery makes a lead, and no external identifier is registered. """
        salesman = self.user_sales_salesman
        vals = {
            'name': 'Unkeyed Lead',
            'contact_name': '',
            'phone': '',
            'email_from': '',
            'expected_revenue': 10.0,
            'stage_id': self.stage_gen_1.id,
        }
        # fixed, with letters, so that its upper-case variant is not a valid key
        hex_key = '0123456789abcdef' * 2
        invalid_keys = [
            hex_key.upper(), hex_key[:-1], hex_key + '0', f'{hex_key[:-1]}g', f' {hex_key}',
            f'{hex_key}\n', int(hex_key, 16), False, None,
        ]
        for key in invalid_keys:
            with self.subTest(key=key):
                for _delivery in range(2):
                    self._quick_create(salesman, vals, key)
        leads = self.env['crm.lead'].search([('name', '=', 'Unkeyed Lead')])
        self.assertEqual(len(leads), 2 * len(invalid_keys))
        self.assertEqual(set(leads.mapped('type')), {'opportunity'})
        self.assertFalse(self.env['ir.model.data'].search([('model', '=', 'crm.lead'), ('res_id', 'in', leads.ids)]))
        self.assertFalse(self.env['ir.model.data'].search([('module', '=', '__crm_offline__'), ('name', 'ilike', hex_key[:-1])]))

        # a write with a valid key is a plain write too
        lead = leads[0]
        context = dict(self.pipeline_context, crm_offline_create_key=hex_key)
        lead.with_user(salesman).with_context(context).web_save({'expected_revenue': 11.0}, specification={})
        self.assertEqual(lead.expected_revenue, 11.0)
        self.assertFalse(self._quick_create_xmlids(hex_key))

    def test_offline_quick_create_replay_key_external_id(self):
        """ The delivery key is registered as the external identifier
        ``__crm_offline__.<key>`` of its lead, which deleting the lead removes:
        the same key then creates the lead again. """
        salesman = self.user_sales_salesman
        key = secrets.token_hex(16)
        vals = {
            'name': 'Registered Lead',
            'contact_name': '',
            'phone': '',
            'email_from': '',
            'expected_revenue': 50.0,
            'stage_id': self.stage_gen_1.id,
        }
        [delivered] = self._quick_create(salesman, vals, key)
        lead = self.env['crm.lead'].browse(delivered['id'])
        xmlid = self._quick_create_xmlids(key)
        self.assertEqual(len(xmlid), 1)
        self.assertEqual(
            (xmlid.model, xmlid.res_id, xmlid.noupdate, xmlid.complete_name),
            ('crm.lead', lead.id, True, f'__crm_offline__.{key}'),
        )
        self.assertEqual(self.env.ref(f'__crm_offline__.{key}'), lead)

        # deleted (the salesman has no delete right): its external identifier goes
        lead.unlink()
        self.assertFalse(self._quick_create_xmlids(key))
        [recreated] = self._quick_create(salesman, vals, key)
        self.assertNotEqual(recreated['id'], delivered['id'])
        self.assertEqual(self.env['crm.lead'].search([('name', '=', 'Registered Lead')]).ids, [recreated['id']])
        self.assertEqual(self._quick_create_xmlids(key).res_id, recreated['id'])

        # an external identifier left behind by a lead deleted without the ORM is
        # taken over by the next delivery of its key
        self.env.cr.execute('DELETE FROM crm_lead WHERE id = %s', [recreated['id']])
        self.env['crm.lead'].invalidate_model()
        [taken_over] = self._quick_create(salesman, vals, key)
        self.assertNotIn(taken_over['id'], (delivered['id'], recreated['id']))
        self.assertEqual(self._quick_create_xmlids(key).res_id, taken_over['id'])
        self.assertEqual(self._quick_create(salesman, vals, key), [taken_over])

    # An offline-created lead keeps one delivery key across replay and online saves:
    # saved online while its own create replays, it is created once and keeps the
    # later values.

    def _form_create(self, user, vals, key, specification=None, queued_by=None, later_save=False):
        """ Deliver the create a lead form sends for its new lead, as ``user``:
        ``web_save([], vals)`` with the form's context (the pipeline action's,
        with the user's ``uid`` the web client adds) and the lead's delivery key.
        ``queued_by`` adds the ``crm_offline_uid`` of a queued call: the form's
        queued create, as its replay sends it; without it, the call is the form's
        online save of the still-new lead. ``later_save`` adds the
        ``crm_offline_create_write`` flag of a save made once a delivery of the
        key was sent or queued.

        :return: the ``web_save`` answer
        """
        context = dict(self.pipeline_context, uid=user.id, crm_offline_create_key=key)
        if queued_by:
            context['crm_offline_uid'] = queued_by.id
        if later_save:
            context['crm_offline_create_write'] = True
        return self.env['crm.lead'].with_user(user).with_context(context).browse().web_save(
            vals, specification={} if specification is None else specification,
        )

    def test_offline_form_create_replayed_then_saved_online_creates_once(self):
        """ A lead created in the form offline queues its create with a delivery
        key. Saved online while that create replays, the still-new lead sends a
        create again, with the same key and the later-save flag: the replay
        creates the lead, and the online save, which the form sends after it,
        writes its values on that lead under the caller's rights and reads it
        back, so the form shows its id. One lead, with the values of the user's
        last save. """
        salesman = self.user_sales_salesman
        key = secrets.token_hex(16)
        queued_vals = {
            'name': 'Form Offline Lead',
            'type': 'opportunity',
            'user_id': salesman.id,
            'stage_id': self.stage_gen_1.id,
            'expected_revenue': 100.0,
            'phone': '+32 494 10 10 10',
        }
        [replayed] = self._form_create(salesman, queued_vals, key, queued_by=salesman)
        self.assertEqual(set(replayed), {'id'})
        lead = self.env['crm.lead'].browse(replayed['id'])
        self.assertEqual((lead.create_uid, lead.name, lead.expected_revenue), (salesman, 'Form Offline Lead', 100.0))
        self.assertEqual(self._quick_create_xmlids(key).res_id, lead.id)

        # the online save of the still-new lead: every value of the form, edited
        online_vals = dict(queued_vals, name='Form Online Lead', expected_revenue=250.0, phone='+32 494 20 20 20')
        CrmLead = self.registry['crm.lead']
        write = CrmLead.write
        writes = []

        def record_write(records, vals):
            writes.append((records.ids, records.env.uid, records.env.su))
            return write(records, vals)

        with patch.object(CrmLead, 'write', record_write):
            answer = self._form_create(
                salesman, online_vals, key, specification={'name': {}, 'expected_revenue': {}, 'phone': {}},
                later_save=True,
            )
        self.assertEqual(writes, [(lead.ids, salesman.id, False)], 'The online save is written as the caller, without sudo')
        self.assertEqual(answer, [{
            'id': lead.id,
            'name': 'Form Online Lead',
            'expected_revenue': 250.0,
            'phone': '+32 494 20 20 20',
        }], 'The online save is answered as a save of the replayed lead')
        leads = self.env['crm.lead'].with_context(active_test=False).search(
            [('name', 'in', ('Form Offline Lead', 'Form Online Lead'))],
        )
        self.assertEqual(leads, lead, 'The replay and the online save make one lead')
        for fname, value in online_vals.items():
            with self.subTest(field=fname):
                self.assertEqual(lead[fname].id if fname in ('user_id', 'stage_id') else lead[fname], value)
        self.assertEqual(len(self._quick_create_xmlids(key)), 1)

        # an online save whose connection is lost is queued into the lead's queued
        # create, with its key and flag: that create, sent again, still makes one lead
        self.assertEqual(
            self._form_create(salesman, online_vals, key, queued_by=salesman, later_save=True), [{'id': lead.id}],
        )
        leads = self.env['crm.lead'].with_context(active_test=False).search(
            [('name', 'in', ('Form Offline Lead', 'Form Online Lead'))],
        )
        self.assertEqual(leads, lead)
        self.assertEqual((lead.name, lead.expected_revenue), ('Form Online Lead', 250.0))

    def test_offline_form_create_key_of_another_user(self):
        """ The delivery key of a lead another user's form created is refused,
        whoever may write the lead: neither the replayed create nor the online
        save of another user creates or writes anything. """
        salesman = self.user_sales_salesman
        manager = self.user_sales_manager
        key = secrets.token_hex(16)
        vals = {
            'name': 'Form Foreign Key Lead',
            'type': 'opportunity',
            'user_id': salesman.id,
            'stage_id': self.stage_gen_1.id,
            'expected_revenue': 40.0,
        }
        [delivered] = self._form_create(salesman, vals, key, queued_by=salesman)
        lead = self.env['crm.lead'].browse(delivered['id'])
        self.assertTrue(lead.with_user(manager).has_access('write'), 'The manager may write the lead itself')
        for queued_by in (manager, None):
            for later_save in (False, True):
                with self.subTest(queued=bool(queued_by), later_save=later_save), \
                        self.assertRaises(AccessError) as refused:
                    self._form_create(
                        manager, dict(vals, expected_revenue=999.0), key, queued_by=queued_by, later_save=later_save,
                    )
                # sent by its own user: not an origin refusal
                self.assertNotIsInstance(refused.exception, CrmOfflineOriginError)
        leads = self.env['crm.lead'].with_context(active_test=False).search([('name', '=', 'Form Foreign Key Lead')])
        self.assertEqual(leads, lead)
        self.assertEqual(lead.expected_revenue, 40.0)
        self.assertEqual(self._quick_create_xmlids(key).res_id, lead.id)

    # ------------------------------------------------------------
    # Queue identity
    # ------------------------------------------------------------

    def _queued_by(self, records, caller, origin, context=None):
        """ ``records`` as a queued call reaches them when it is replayed in
        ``caller``'s session: with the call's ``context`` plus the id of the user
        who queued it (``origin``), which the CRM web client adds to every call it
        queues under the ``crm_offline_uid`` key. """
        return records.with_user(caller).with_context(dict(context or {}, crm_offline_uid=origin.id))

    @contextmanager
    def _assert_queued_by_another_user(self):
        """ Assert the block raises the ``CrmOfflineOriginError``, an
        ``AccessError``, refusing a call queued offline by another user. Unlike
        ``assertRaises``, no savepoint is rolled back on the error, so whatever
        the call changed before being refused stays visible to the assertions
        that it changed nothing. """
        try:
            yield
        except AccessError as error:
            self.assertIsInstance(error, CrmOfflineOriginError)
            self.assertEqual(
                error.args[0], "This offline change was sent in another user's session and was not applied.",
            )
        else:
            self.fail("A call queued offline by another user was applied")

    def test_offline_replay_queued_by_another_user_lead_calls(self):
        """ A browser keeps one offline queue for every session it holds, and
        pages that do not load the CRM client code (website, portal) replay it
        in whatever session they have. Each ``crm.lead`` call the CRM queue
        replays (edit, create, archive, unarchive, won, delete) is refused when
        the user who queued it is not the caller, and changes nothing; the same
        call queued by the caller is applied as before. """
        salesman, other, manager = self.user_sales_salesman, self.user_sales_leads, self.user_sales_manager
        lead = self._create_salesman_opportunity('Queued Identity Lead', expected_revenue=100)
        context = self.pipeline_context

        def lead_audit():
            # with the tracking messages of the writes made so far
            self.env.cr.flush()
            lead.invalidate_recordset()
            return (lead.name, lead.expected_revenue, lead.active, lead.stage_id, lead.probability,
                    lead.won_status, lead.write_uid, lead.message_ids)

        # edit (form save, card stage move or colour)
        before = lead_audit()
        with self._assert_queued_by_another_user():
            self._queued_by(lead, salesman, other, context).web_save(
                {'name': 'Foreign Pending', 'expected_revenue': 1777}, specification={},
            )
        self.assertEqual(lead_audit(), before)
        self._queued_by(lead, salesman, salesman, context).web_save(
            {'name': 'Own Pending', 'expected_revenue': 1777}, specification={},
        )
        lead.invalidate_recordset()
        self.assertEqual((lead.name, lead.expected_revenue, lead.write_uid), ('Own Pending', 1777, salesman))
        # a boolean is no user id: the call is checked as without one
        lead.with_user(salesman).with_context(context, crm_offline_uid=True).web_save(
            {'expected_revenue': 1888}, specification={},
        )
        self.assertEqual(lead_audit()[1], 1888)

        # archive, then unarchive (form action menu)
        before = lead_audit()
        with self._assert_queued_by_another_user():
            self._queued_by(lead, salesman, other, context).action_archive()
        self.assertEqual(lead_audit(), before)
        self._queued_by(lead, salesman, salesman, context).action_archive()
        self.assertFalse(lead_audit()[2])
        before = lead_audit()
        with self._assert_queued_by_another_user():
            self._queued_by(lead, salesman, other, context).action_unarchive()
        self.assertEqual(lead_audit(), before)
        self._queued_by(lead, salesman, salesman, context).action_unarchive()
        self.assertTrue(lead_audit()[2])

        # won (form Won button)
        before = lead_audit()
        self.assertEqual(before[5], 'pending')
        with self._assert_queued_by_another_user():
            self._queued_by(lead, salesman, other, context).action_set_won()
        self.assertEqual(lead_audit(), before)
        self.assertTrue(self._queued_by(lead, salesman, salesman, context).action_set_won())
        self.assertEqual(lead_audit()[3:6], (self.stage_gen_won, 100, 'won'))

        # create (mobile quick create, with its delivery key, and form create)
        vals = {
            'name': 'Queued Create Lead',
            'contact_name': 'Queued Contact',
            'phone': '+32 494 77 77 77',
            'email_from': 'queued@example.com',
            'expected_revenue': 2777.0,
            'stage_id': self.stage_gen_1.id,
        }
        key = secrets.token_hex(16)
        for create_key in (key, None):
            with self.subTest(create_key=create_key), self._assert_queued_by_another_user():
                create_context = dict(context, crm_offline_create_key=create_key)
                self._queued_by(self.env['crm.lead'], salesman, other, create_context).web_save(vals, specification={})
        created = self.env['crm.lead'].with_context(active_test=False).search([('name', '=', vals['name'])])
        self.assertFalse(created)
        self.assertFalse(self._quick_create_xmlids(key))
        [delivered] = self._queued_by(
            self.env['crm.lead'], salesman, salesman, dict(context, crm_offline_create_key=key),
        ).web_save(vals, specification={})
        created = self.env['crm.lead'].with_context(active_test=False).search([('name', '=', vals['name'])])
        self.assertEqual(created.ids, [delivered['id']])
        self.assertEqual((created.create_uid, created.user_id, created.type), (salesman, salesman, 'opportunity'))
        self.assertEqual(self._quick_create_xmlids(key).res_id, created.id)

        # delete (card menu or form action menu), by a user allowed to delete
        doomed = self._create_salesman_opportunity('Queued Delete Lead')
        with self._assert_queued_by_another_user():
            self._queued_by(doomed, manager, salesman, context).unlink()
        self.assertTrue(doomed.exists())
        self._queued_by(doomed, manager, manager, context).unlink()
        self.assertFalse(doomed.exists())

    def test_offline_replay_queued_by_another_user_activity_calls(self):
        """ The activity calls the CRM queue replays ("Log a call", "Schedule
        follow-up", "Mark done") are refused when queued by another user than
        the caller, and leave the lead's activities as they were. """
        salesman, other = self.user_sales_salesman, self.user_sales_leads
        lead = self._create_salesman_opportunity('Queued Activity Lead')
        vals = {
            'res_model': 'crm.lead',
            'res_id': lead.id,
            'activity_type_id': self.call_type.id,
            'summary': 'Call',
            'date_deadline': fields.Date.to_string(fields.Date.today()),
            'user_id': salesman.id,
        }

        def lead_activities():
            return self.env['mail.activity'].with_context(active_test=False).search([
                ('res_model', '=', 'crm.lead'), ('res_id', '=', lead.id),
            ])

        with self._assert_queued_by_another_user():
            self._queued_by(self.env['mail.activity'], salesman, other).create([dict(vals)])
        self.assertFalse(lead_activities())
        activity = self._queued_by(self.env['mail.activity'], salesman, salesman).create([dict(vals)])
        self.assertEqual(lead_activities(), activity)
        self.assertEqual((activity.create_uid, activity.user_id), (salesman, salesman))
        self.assertEqual(activity.sudo().res_model_id.model, 'crm.lead')

        with self._assert_queued_by_another_user():
            self._queued_by(activity, salesman, other).action_done()
        lead.invalidate_recordset(['activity_ids'])
        self.assertEqual(lead.activity_ids, activity)
        self.assertEqual(lead_activities(), activity)
        self.assertTrue(activity.active)
        self.assertFalse(self._get_activity_done_messages(lead, self.call_type))
        self._queued_by(activity, salesman, salesman).action_done()
        lead.invalidate_recordset(['activity_ids'])
        self.assertFalse(lead.activity_ids)
        self.assertEqual(len(self._get_activity_done_messages(lead, self.call_type)), 1)

    def test_offline_replay_queued_by_another_user_stage_and_team_saves(self):
        """ The stage form save and the Sales Teams card colour, queued offline,
        are refused when queued by another user than the caller (a manager, who
        may write both), and change nothing. """
        manager, salesman = self.user_sales_manager, self.user_sales_salesman
        team_color = 1 if self.sales_team_1.color != 1 else 2
        for record, fname, value in (
            (self.stage_gen_1, 'name', 'Queued Stage'),
            (self.sales_team_1, 'color', team_color),
        ):
            with self.subTest(model=record._name):
                record.invalidate_recordset()
                before = (record[fname], record.write_uid)
                self.assertNotEqual(before[0], value)
                with self._assert_queued_by_another_user():
                    self._queued_by(record, manager, salesman).web_save({fname: value}, specification={})
                record.invalidate_recordset()
                self.assertEqual((record[fname], record.write_uid), before)
                self._queued_by(record, manager, manager).web_save({fname: value}, specification={})
                record.invalidate_recordset()
                self.assertEqual((record[fname], record.write_uid), (value, manager))

    def test_offline_replay_queued_by_another_user_through_json_rpc(self):
        """ The replay a page without the CRM client code sends, through the web
        client's JSON-RPC route in the session of the user signed in on the
        browser, of a lead edit another user queued: refused, the lead is left
        as it was. The same call queued by the signed-in user is applied. """
        salesman, other = self.user_sales_salesman, self.user_sales_leads
        lead = self._create_salesman_opportunity('Queued Route Lead', expected_revenue=100)
        before = (lead.name, lead.expected_revenue, lead.write_uid)
        self.authenticate(salesman.login, salesman.login)
        call = {
            'model': 'crm.lead',
            'method': 'web_save',
            'args': [[lead.id], {'name': 'Route Pending', 'expected_revenue': 1777}],
            'kwargs': {
                'context': dict(self.pipeline_context, uid=other.id, crm_offline_uid=other.id),
                'specification': {},
            },
        }
        with self.assertRaises(JsonRpcException) as refused, mute_logger('odoo.http'):
            self.make_jsonrpc_request('/web/dataset/call_kw/crm.lead/web_save', call)
        # the JSON-RPC error's data.name
        self.assertEqual(refused.exception.args[0], 'odoo.addons.crm.models.crm_lead.CrmOfflineOriginError')
        lead.invalidate_recordset()
        self.assertEqual((lead.name, lead.expected_revenue, lead.write_uid), before)

        call['kwargs']['context'].update(uid=salesman.id, crm_offline_uid=salesman.id)
        self.assertEqual(self.make_jsonrpc_request('/web/dataset/call_kw/crm.lead/web_save', call), [{'id': lead.id}])
        lead.invalidate_recordset()
        self.assertEqual((lead.name, lead.expected_revenue, lead.write_uid), ('Route Pending', 1777, salesman))

    # ------------------------------------------------------------
    # Stage choices of an ungrouped list
    # ------------------------------------------------------------

    def test_web_search_read_stage_choices(self):
        """ The online reload of an ungrouped mobile lead list after a discarded
        offline change sends its ``web_search_read`` with ``crm_stage_choices`` in
        its context: the answer also lists, under that key, the stages the same
        search shows when grouped by stage, in stage order, read under the
        caller's rights. A stage of no sales team that no lead has is listed, a
        deleted stage is not, nor is the stage of a lead the caller cannot read.
        Records and length are those of the call without the key, whose answer
        is the base one. """
        salesman = self.user_sales_salesman
        own_lead = self._create_salesman_opportunity('Choices Lead')
        empty_stage = self.env['crm.stage'].create({'name': 'Empty Stage', 'sequence': 2, 'team_ids': False})
        deleted_stage = self.env['crm.stage'].create({'name': 'Deleted Stage', 'sequence': 2, 'team_ids': False})
        hidden_stage = self.env['crm.stage'].create({
            'name': 'Hidden Team Stage', 'sequence': 4, 'team_ids': [self.sales_team_1.id],
        })
        hidden_lead = self.env['crm.lead'].create({
            'name': 'Hidden Lead',
            'type': 'opportunity',
            'user_id': self.user_sales_manager.id,
            'team_id': self.sales_team_1.id,
            'stage_id': hidden_stage.id,
        })
        deleted_stage.unlink()
        domain = self.pipeline_domain
        specification = {'name': {}, 'stage_id': {'fields': {'display_name': {}}}}
        leads = self.env['crm.lead'].with_user(salesman).with_context(self.pipeline_context)
        self.assertFalse(leads.search([('id', '=', hidden_lead.id)]), 'The salesperson cannot read the hidden lead')

        plain = leads.web_search_read(domain, specification, limit=80)
        self.assertEqual(set(plain), {'length', 'records'})
        self.assertIn(own_lead.id, [record['id'] for record in plain['records']])
        self.assertEqual(leads.with_context(crm_stage_choices=False).web_search_read(domain, specification, limit=80), plain)

        flagged = leads.with_context(crm_stage_choices=True).web_search_read(domain, specification, limit=80)
        self.assertEqual(set(flagged), {'length', 'records', 'crm_stage_choices'})
        self.assertEqual(flagged['records'], plain['records'])
        self.assertEqual(flagged['length'], plain['length'])

        # the stages of the salesperson's leads of the search and every stage of no
        # sales team (the salesperson is in none), in stage order
        expected = self.env['crm.stage'].search([
            '|', ('id', 'in', leads.search(domain).stage_id.ids), ('team_ids', '=', False),
        ])
        self.assertEqual(
            flagged['crm_stage_choices'],
            [{'id': stage.id, 'display_name': stage.display_name} for stage in expected],
        )
        choice_ids = [stage['id'] for stage in flagged['crm_stage_choices']]
        self.assertIn(self.stage_gen_1.id, choice_ids)
        self.assertIn(empty_stage.id, choice_ids)
        self.assertNotIn(deleted_stage.id, choice_ids)
        self.assertNotIn(hidden_stage.id, choice_ids)
        self.assertLess(choice_ids.index(empty_stage.id), choice_ids.index(self.stage_gen_1.id))

        # a caller who reads the hidden lead (here the superuser) gets its stage
        superuser_choices = self.env['crm.lead'].with_context(self.pipeline_context, crm_stage_choices=True).web_search_read(
            domain, specification, limit=80,
        )['crm_stage_choices']
        self.assertIn(hidden_stage.id, [stage['id'] for stage in superuser_choices])

    # ------------------------------------------------------------
    # Wiring
    # ------------------------------------------------------------

    def test_offline_wiring(self):
        """ Check mobile view classes and Call-type options, offline Won, the
        two kanban arches' expected field sets, bundle membership and manifest
        version 1.10. Parse each view's own arch because installed addons may
        extend it. """
        call_type_id = self.env.ref('mail.mail_activity_data_call').id

        # expected kanban fields: mobile-only additions belong in load variants, not arch declarations
        base_kanban_fields = {
            'crm.view_crm_lead_kanban': {
                'name', 'contact_name', 'tag_ids', 'priority', 'activity_ids', 'user_id',
            },
            'crm.crm_case_kanban_view_leads': {
                'stage_id', 'probability', 'active', 'company_currency', 'recurring_revenue_monthly',
                'team_id', 'won_status', 'color', 'name', 'expected_revenue', 'recurring_revenue',
                'recurring_plan', 'partner_id', 'contact_name', 'partner_name', 'tag_ids',
                'lead_properties', 'priority', 'activity_ids', 'is_rotting', 'rotting_days', 'user_id',
            },
        }
        for xmlid, base_fields in base_kanban_fields.items():
            with self.subTest(view=xmlid):
                arch = etree.fromstring(self.env.ref(xmlid).arch)
                self.assertEqual(arch.tag, 'kanban')
                self.assertEqual(arch.get('js_class'), 'crm_mobile_pipeline')
                activity_fields = arch.xpath("//field[@name='activity_ids']")
                self.assertEqual(len(activity_fields), 1)
                self.assertEqual(
                    ast.literal_eval(activity_fields[0].get('options')),
                    {'crm_call_activity_type_id': call_type_id},
                )
                self.assertEqual({node.get('name') for node in arch.xpath('//field')}, base_fields)

        form_arch = etree.fromstring(self.env.ref('crm.crm_lead_view_form').arch)
        won_buttons = form_arch.xpath("//header/button[@name='action_set_won_rainbowman']")
        self.assertEqual(len(won_buttons), 1)
        self.assertEqual(won_buttons[0].get('data-available-offline'), '1')
        stage_fields = form_arch.xpath("//field[@name='stage_id']")
        self.assertEqual(len(stage_fields), 1)
        self.assertEqual(
            ast.literal_eval(stage_fields[0].get('options')),
            {'clickable': '1', 'fold_field': 'fold', 'crm_call_activity_type_id': call_type_id},
        )

        # the forecast kanban inherits the pipeline arch and keeps its own view
        forecast_view = self.env.ref('crm.crm_lead_view_kanban_forecast')
        forecast_js_class = etree.fromstring(forecast_view.arch).xpath(
            "//xpath[@expr='//kanban']/attribute[@name='js_class']",
        )
        self.assertEqual([node.text for node in forecast_js_class], ['forecast_kanban'])
        self.assertEqual(forecast_view._get_combined_arch().get('js_class'), 'forecast_kanban')

        # assets: each new file is bundled by the existing globs where it runs
        def get_bundle_paths(bundle):
            return {asset[0] for asset in self.env['ir.asset']._get_asset_paths(bundle, {})}

        mobile_dir = '/crm/static/src/mobile'
        backend_files = {f'{mobile_dir}/crm_offline_hooks.js'} | {
            f'{mobile_dir}/{component}/{component}.{extension}'
            for component in ('crm_mobile_pipeline', 'crm_mobile_lead_card', 'crm_mobile_quick_create')
            for extension in ('js', 'xml', 'scss')
        }
        self.assertEqual(len(backend_files), 10)
        backend_paths = get_bundle_paths('web.assets_backend')
        self.assertFalse(backend_files - backend_paths, 'Every mobile file is in the backend bundle')
        self.assertNotIn(f'{mobile_dir}/offline_inventory.md', backend_paths, 'The inventory is not an asset')

        unit_test_paths = get_bundle_paths('web.assets_unit_tests')
        self.assertIn('/crm/static/tests/crm_offline.test.js', unit_test_paths)
        self.assertIn('/crm/static/tests/crm_mobile_pipeline.test.js', unit_test_paths)
        self.assertIn('/crm/static/tests/tours/crm_mobile_offline.js', get_bundle_paths('web.assets_tests'))

        # version: the raw manifest value (the loaded one is prefixed by the series)
        with file_open('crm/__manifest__.py') as manifest_file:
            manifest = ast.literal_eval(manifest_file.read())
        self.assertEqual(manifest['version'], '1.10')

    # ------------------------------------------------------------
    # Tour
    # ------------------------------------------------------------

    def test_crm_mobile_offline_tour(self):
        """ The full offline write-and-replay cycle on a phone: the tour caches
        the pipeline and "Synced Lead" online, then, offline, edits the lead,
        creates "Offline Lead", logs a call, marks the fixture activity done and
        marks the lead won; it ends once the queue has replayed. Every change
        must have reached the server as the salesperson.

        The fixture values below are the contract with the tour
        (``crm/static/tests/tours/crm_mobile_offline.js``). """
        salesman = self.user_sales_salesman
        synced_lead = self._create_salesman_opportunity('Synced Lead', expected_revenue=1000)
        fixture_activity = synced_lead.activity_schedule(
            'mail.mail_activity_data_todo', summary='Fixture Activity', user_id=salesman.id,
        )
        self.assertEqual(synced_lead.activity_ids, fixture_activity)
        self.assertFalse(self.env['crm.lead'].with_context(active_test=False).search_count([('name', '=', 'Offline Lead')]))
        # the OdooBot onboarding chat would open full screen on the phone
        # viewport at an unpredictable moment and cover the tour
        if 'odoobot_state' in self.env['res.users']._fields:
            salesman.odoobot_state = 'disabled'

        # the first page of a new browser is not controlled by the service
        # worker, so the web client clears every offline cache once the worker
        # activates: the tour starts after that, or what it caches online is lost
        self.start_tour(
            '/odoo', 'crm_mobile_offline', login='user_sales_salesman',
            ready="odoo.isTourReady('crm_mobile_offline') && navigator.serviceWorker.ready.then(() => true)",
        )

        self.env.invalidate_all()
        lead = synced_lead.with_user(salesman)

        self.assertEqual(lead.expected_revenue, 4242)
        self.assertEqual(lead.won_status, 'won')
        self.assertTrue(lead.stage_id.is_won)
        self.assertEqual(lead.probability, 100)

        # "Log a call": the only remaining activity, linked through res_model_id
        call_activity = lead.activity_ids
        self.assertEqual(len(call_activity), 1)
        self.assertNotEqual(call_activity, fixture_activity)
        self.assertEqual(call_activity.activity_type_id, self.call_type)
        self.assertEqual(call_activity.summary, 'Call')
        self.assertEqual(call_activity.user_id, salesman)
        self.assertEqual(call_activity.res_model, 'crm.lead')
        # ir.model is not readable by salespersons: the link is read as superuser
        self.assertEqual(call_activity.sudo().res_model_id.model, 'crm.lead')
        self.assertEqual(call_activity.res_id, synced_lead.id)
        # sent with its delivery key, registered once with the activity it created
        call_key = self.env['ir.model.data'].search([
            ('module', '=', '__crm_offline__'), ('model', '=', 'mail.activity'), ('res_id', '=', call_activity.id),
        ])
        self.assertEqual(len(call_key), 1)
        self.assertRegex(call_key.name, r'^[0-9a-f]{32}$')
        # the deadline is the browser's "today", which may differ from the server's by the timezone
        self.assertTrue(call_activity.date_deadline)
        self.assertLessEqual(abs(call_activity.date_deadline - fields.Date.today()), timedelta(days=1))

        self.assertNotIn(fixture_activity, lead.activity_ids)
        self.assertTrue(not fixture_activity.exists() or not fixture_activity.active)
        self.assertEqual(len(self._get_activity_done_messages(synced_lead, self.todo_type)), 1)

        offline_lead = self.env['crm.lead'].with_user(salesman).search([('name', '=', 'Offline Lead')])
        self.assertEqual(len(offline_lead), 1)
        self.assertEqual(offline_lead.type, 'opportunity')
        self.assertEqual(offline_lead.stage_id, self.stage_gen_1)
        self.assertEqual(offline_lead.user_id, salesman)
        self.assertEqual(
            self.env['crm.lead'].with_user(salesman).search(self.pipeline_domain + [('id', '=', offline_lead.id)]),
            offline_lead,
        )
