import { registry } from "@web/core/registry";
import { ShareTargetItem } from "@web/webclient/share_target/share_target_item";
import { onWillStart, untrack, useEffect, usePlugin } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { FormViewDialog } from "@web/views/view_dialogs/form_view_dialog";
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
        // Track the offline signal only, and read the teams again on reconnection; the first
        // run does not, so an online start-up keeps the single read of onWillStart. The
        // untrack covers the reactive state updateTeams reads (this.context). A read lost to
        // a new disconnection is ignored; any other error reaches the framework error service.
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
        // Skip the team read offline; the team list and the selection are kept.
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
     * the attachments need the id of a lead created on the server. A save entered offline
     * returns before the upload. For a save started online, the steps below recheck the
     * connection: createRecordWithFile after the upload and after the lead creation,
     * _createRecord when name_create loses the connection, and openCreatedRecord before
     * navigating. A request already sent is not cancelled.
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
     * The base steps, with a connection check before the lead creation (an upload that ended
     * offline, a direct call) and before the attachment relink (a name_create that lost the
     * connection, or a form fallback whose save the framework queued offline, without an
     * id); the base method has no hook between them. Offline, it returns null and leaves the
     * attachments unlinked.
     *
     * @override
     * @returns {Promise<?number>} the created lead id, or null if the record wasn't saved
     */
    async createRecordWithFile(attachments) {
        if (this.offlinePlugin.isOffline()) {
            return null;
        }
        // Base steps, not super, online too: super can't recheck between name_create and relink.
        const { filename } = attachments[0];
        const resId = await this._createRecord(filename, this.context);
        if (resId === null || this.offlinePlugin.isOffline()) {
            return null;
        }
        const attachmentIds = attachments.map((a) => a.id);
        await this.orm.write("ir.attachment", attachmentIds, {
            res_id: resId,
            res_model: this.modelName,
        });
        return resId;
    }

    /**
     * The base steps, except that an offline entry, or a name_create that loses the
     * connection, returns null without the form dialog fallback, which cannot create a lead
     * offline; the base method catches every error into that fallback. Any other name_create
     * error opens the fallback, as in the base.
     *
     * @override
     * @returns {Promise<?number>} the created lead id, or null if the record wasn't saved
     */
    async _createRecord(name, context) {
        if (this.offlinePlugin.isOffline()) {
            return null;
        }
        // Base steps, not super, online too: super can't recheck between name_create and fallback.
        try {
            const [resId] = await this.orm.call(this.modelName, "name_create", [name], {
                context,
            });
            return resId;
        } catch (error) {
            if (error instanceof ConnectionLostError || this.offlinePlugin.isOffline()) {
                return null;
            }
            // fallback on form view dialog when name_create fails
            return new Promise((resolve) => {
                this.dialog.add(FormViewDialog, {
                    canExpand: false,
                    close: resolve,
                    context: {
                        ...context,
                        default_name: name,
                    },
                    title: name,
                    resModel: this.modelName,
                    onRecordSaved: ({ resId }) => resolve(resId),
                });
            });
        }
    }

    /**
     * Skips the navigation when entered offline.
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
     * Keeps the active companies when entered offline, where the share save cannot start.
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
