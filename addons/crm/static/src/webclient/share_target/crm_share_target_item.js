import { registry } from "@web/core/registry";
import { ShareTargetItem } from "@web/webclient/share_target/share_target_item";
import { onWillStart, untrack, useEffect, usePlugin } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { crmOwnEffectPromise } from "@crm/mobile/crm_offline_hooks";

export class CrmShareTargetItem extends ShareTargetItem {
    static template = "crm.ShareTargetItem";
    static name = _t("Lead");
    static sequence = 4;

    setup() {
        super.setup();
        this.offlinePlugin = usePlugin(OfflinePlugin);
        this.teamsDomain = [["company_id", "in", [this.currentCompany.id, false]]];
        onWillStart(() => this.updateTeams());
        // The team read is skipped offline (see updateTeams), so reload the teams once the
        // connection comes back. Only the offline signal is tracked: updateTeams reads reactive
        // state synchronously (this.context), hence the untrack. The first, immediate run never
        // reloads, so an online start-up still issues a single team read, from onWillStart.
        // A read lost to the connection dropping again keeps the teams and the selection and is
        // retried at the next reconnection; any other error goes to the framework error service.
        let wasOffline = false;
        useEffect(() => {
            const offline = this.offlinePlugin.isOffline();
            if (wasOffline && !offline) {
                untrack(() => crmOwnEffectPromise(this.updateTeams()));
            }
            wasOffline = offline;
        });
    }

    async updateTeams() {
        // The lead share target is DISABLE offline (crm/static/src/mobile/offline_inventory.md):
        // no crm.team read, the previous team list and selection are kept.
        if (this.offlinePlugin.isOffline()) {
            return;
        }
        this.state.teams = await this.orm
            .webSearchRead("crm.team", this.teamsDomain, {
                specification: { id: {}, display_name: {} },
                context: this.context
            })
            .then(({ records }) => records);
        this.state.selected_team = this.state.teams.length
            ? this.state.teams[0]
            : false;
    }

    onCompanyChange(companyId) {
        super.onCompanyChange(companyId);
        this.teamsDomain = [["company_id", "in", [this.currentCompany.id, false]]];
        this.updateTeams();
    }

    /**
     * The lead share target is DISABLE offline (crm/static/src/mobile/offline_inventory.md):
     * the attachments need the id of a lead created on the server, so nothing is uploaded,
     * created, written or opened while offline. This entry guard covers a save started
     * offline; a save started online stops at the create and open steps below when the
     * connection drops meanwhile.
     *
     * @override
     */
    async process() {
        if (this.offlinePlugin.isOffline()) {
            return;
        }
        return super.process(...arguments);
    }

    /**
     * DISABLE offline (crm/static/src/mobile/offline_inventory.md): a save started online
     * whose upload ends after the connection is lost stops here, as does a direct call. The
     * lead is not created, so the uploaded attachments are not relinked. Returns null, the
     * "record wasn't saved" value of the base contract.
     *
     * @override
     */
    async createRecordWithFile(attachments) {
        if (this.offlinePlugin.isOffline()) {
            return null;
        }
        return super.createRecordWithFile(...arguments);
    }

    /**
     * DISABLE offline (crm/static/src/mobile/offline_inventory.md): a direct call issues no
     * name_create and opens no form dialog. Returns null, the "record wasn't saved" value of
     * the base contract.
     *
     * @override
     */
    async _createRecord(name, context) {
        if (this.offlinePlugin.isOffline()) {
            return null;
        }
        return super._createRecord(...arguments);
    }

    /**
     * DISABLE offline (crm/static/src/mobile/offline_inventory.md): a save stopped by the
     * connection loss, like a direct call, opens no record.
     *
     * @override
     */
    async openCreatedRecord(resId) {
        if (this.offlinePlugin.isOffline()) {
            return;
        }
        return super.openCreatedRecord(...arguments);
    }

    /**
     * DISABLE offline (crm/static/src/mobile/offline_inventory.md): the company switch is only
     * the first step of a create that cannot run offline, so the active companies are kept.
     *
     * @override
     */
    async checkAndActiveIfNeededUserCompany() {
        if (this.offlinePlugin.isOffline()) {
            return;
        }
        return super.checkAndActiveIfNeededUserCompany(...arguments);
    }

    get defaultState() {
        return { ...super.defaultState, teams: [], selected_team: false };
    }

    get hasMultiTeams() {
        return this.state.teams.length > 1;
    }

    get modelName() {
        return "crm.lead";
    }
    get context() {
        return {
            ...super.context,
            default_team_id: this.state.selected_team.id,
        };
    }

    get teamRecordProps() {
        return {
            mode: "readonly",
            values: { team: this.state.selected_team },
            fieldNames: ["team"],
            fields: {
                team: {
                    name: "team",
                    type: "many2one",
                    relation: "crm.team",
                    domain: this.teamsDomain,
                },
            },
            hooks: {
                onRecordChanged: (record) => {
                    this.state.selected_team = record.data.team;
                },
            },
        };
    }
}

registry.category("share_target_items").add("crm", CrmShareTargetItem);
