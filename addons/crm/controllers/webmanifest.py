# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo.http import request

from odoo.addons.web.controllers import webmanifest


class WebManifest(webmanifest.WebManifest):

    def _get_shortcuts(self):
        """ Append My Pipeline and New Lead after the parent shortcuts only when a CRM app entry
        exists. Both target the pipeline menu; on a phone, New Lead consumes ``crm_quick_create``
        once to open its sheet. Manifest metadata is cross-device, so a wide screen opens the
        desktop pipeline without the sheet.
        """
        shortcuts = super()._get_shortcuts()
        if not shortcuts:
            return shortcuts
        crm_root = request.env.ref('crm.crm_menu_root', raise_if_not_found=False)
        if not crm_root:
            return shortcuts
        crm_url = '/odoo?menu_id=%s' % crm_root.id
        crm_entry = next((shortcut for shortcut in shortcuts if shortcut['url'] == crm_url), None)
        if not crm_entry:
            return shortcuts
        pipeline_menu = request.env.ref('crm.menu_crm_opportunities', raise_if_not_found=False)
        if not pipeline_menu:
            return shortcuts
        pipeline_url = '/odoo?menu_id=%s' % pipeline_menu.id
        # The CRM app icon is reused for these shortcuts only (the manifest's
        # top-level icons stay Odoo's). Each entry gets its own copy, so no
        # shortcut shares a mutable icon dict with the parent CRM entry.
        shortcuts.extend([{
            'name': request.env._("My Pipeline"),
            'url': pipeline_url,
            'description': request.env._("Open your CRM pipeline"),
            'icons': [dict(icon) for icon in crm_entry['icons']],
        }, {
            'name': request.env._("New Lead"),
            'url': pipeline_url + '&crm_quick_create=1',
            'description': request.env._("Create a lead in your CRM pipeline"),
            'icons': [dict(icon) for icon in crm_entry['icons']],
        }])
        return shortcuts

    def _has_share_target(self):
        return True
