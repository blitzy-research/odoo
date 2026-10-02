# Part of Odoo. See LICENSE file for full copyright and licensing details.

import ast
import copy
from datetime import timedelta
from unittest.mock import patch

from lxml import etree

from odoo import fields
from odoo.tests import HttpCase
from odoo.tests.common import tagged
from odoo.tools import file_open

from odoo.addons.crm.tests.common import TestCrmCommon
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

        # parent entries: present, unchanged, first, and holding the CRM app entry
        self.assertEqual(shortcuts[:len(parent)], parent)
        self.assertEqual(len(shortcuts), len(parent) + 2, "Exactly two CRM shortcuts are appended")
        crm_app_url = '/odoo?menu_id=%s' % self.env.ref('crm.crm_menu_root').id
        crm_app_entries = [shortcut for shortcut in parent if shortcut['url'] == crm_app_url]
        self.assertEqual(len(crm_app_entries), 1, "The parent lists the CRM app")

        # appended entries: names, order and shape
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

        # appended entries: both open "My Pipeline", "New Lead" with the quick create flag
        pipeline_url = '/odoo?menu_id=%s' % self.env.ref('crm.menu_crm_opportunities').id
        self.assertEqual(pipeline_shortcut['url'], pipeline_url)
        self.assertTrue(new_lead_shortcut['url'].startswith(pipeline_url))
        self.assertTrue(new_lead_shortcut['url'].endswith('&crm_quick_create=1'))
        self.assertEqual(new_lead_shortcut['url'], pipeline_url + '&crm_quick_create=1')

        # the shortcut icon is served
        icon_response = self.url_open(expected_icons[0]['src'])
        self.assertEqual(icon_response.status_code, 200)
        self.assertTrue(icon_response.headers['Content-Type'].startswith('image/png'))

        # the rest of the manifest is unchanged
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

    def test_offline_mark_won_replay(self):
        """ Won clicked offline queues ``action_set_won [[resId]]`` with the form
        context, never ``action_set_won_rainbowman``: the server picks the won
        stage when the call replays. """
        salesman = self.user_sales_salesman
        lead = self._create_salesman_opportunity('Offline Won Lead', expected_revenue=500)
        self.assertEqual(lead.won_status, 'pending')
        self.assertFalse(lead.stage_id.is_won)

        result = lead.with_user(salesman).with_context(self.pipeline_context).action_set_won()
        self.assertTrue(result)

        lead.invalidate_recordset()
        self.assertEqual(lead.won_status, 'won')
        self.assertTrue(lead.stage_id.is_won)
        self.assertEqual(lead.stage_id, self.stage_gen_won)
        self.assertEqual(lead.probability, 100)

    def test_offline_activity_create_replay(self):
        """ "Log a call" and "Schedule follow-up" offline queue a ``mail.activity``
        ``create`` naming the document by ``res_model`` only, as the client has no
        ``ir.model`` id offline. ``res_model`` is a readonly related field, so the
        activity is linked to its lead only through CRM's ``create`` override,
        which resolves ``res_model_id``: without it this test fails. """
        salesman = self.user_sales_salesman
        lead = self._create_salesman_opportunity('Offline Activity Lead')
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

    def test_offline_activity_done_replay(self):
        """ "Mark done" offline queues ``mail.activity`` ``action_done
        [[activityId]]``: a state change only, with no feedback, attachment or
        next activity. Replayed, the activity leaves the lead's activities. """
        salesman = self.user_sales_salesman
        lead = self._create_salesman_opportunity('Offline Done Lead')
        activity = lead.activity_schedule('mail.mail_activity_data_todo', summary='Done Me', user_id=salesman.id)
        self.assertEqual(lead.activity_ids, activity)
        self.assertFalse(self._get_activity_done_messages(lead, self.todo_type))

        activity.with_user(salesman).action_done()

        lead.invalidate_recordset(['activity_ids'])
        self.assertNotIn(activity, lead.activity_ids)
        self.assertFalse(activity.exists() and activity.active, 'A done activity is archived or unlinked')
        self.assertEqual(len(self._get_activity_done_messages(lead, self.todo_type)), 1, 'Marking done posts its message')

    def test_offline_quick_create_replay(self):
        """ The mobile quick create queues ``web_save [[], vals]`` with the six
        fields it captures and ``{context: <pipeline list context>,
        specification: {}}``. The server fills the rest at replay, with the
        pipeline's ``default_type``, so the lead stays in the opportunity-only
        pipeline. """
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

    # ------------------------------------------------------------
    # Wiring
    # ------------------------------------------------------------

    def test_offline_wiring(self):
        """ The lead kanban arches use the mobile pipeline view and give their
        activities the Call type, the lead form keeps Won usable offline and
        gives its activity sheet the Call type, no arch declares a new field,
        every new file is bundled where it runs, and the version is bumped.

        Each view record's own arch is parsed, not the combined one, because
        other addons may inherit these views. """
        call_type_id = self.env.ref('mail.mail_activity_data_call').id

        # fields declared by both lead kanban arches before the mobile pipeline
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

        self.start_tour('/odoo', 'crm_mobile_offline', login='user_sales_salesman')

        self.env.invalidate_all()
        lead = synced_lead.with_user(salesman)

        # offline edit, then queued action_set_won
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
        # the deadline is the browser's "today", which may differ from the server's by the timezone
        self.assertTrue(call_activity.date_deadline)
        self.assertLessEqual(abs(call_activity.date_deadline - fields.Date.today()), timedelta(days=1))

        # "Mark done" on the fixture activity
        self.assertNotIn(fixture_activity, lead.activity_ids)
        self.assertTrue(not fixture_activity.exists() or not fixture_activity.active)
        self.assertEqual(len(self._get_activity_done_messages(synced_lead, self.todo_type)), 1)

        # mobile quick create: an opportunity of the salesperson in the chosen stage
        offline_lead = self.env['crm.lead'].with_user(salesman).search([('name', '=', 'Offline Lead')])
        self.assertEqual(len(offline_lead), 1)
        self.assertEqual(offline_lead.type, 'opportunity')
        self.assertEqual(offline_lead.stage_id, self.stage_gen_1)
        self.assertEqual(offline_lead.user_id, salesman)
        self.assertEqual(
            self.env['crm.lead'].with_user(salesman).search(self.pipeline_domain + [('id', '=', offline_lead.id)]),
            offline_lead,
        )
