import { usePlugin } from "@odoo/owl";
import { Domain } from "@web/core/domain";
import { ActivityMenu } from "@mail/core/web/activity_menu";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { patch } from "@web/core/utils/patch";

patch(ActivityMenu.prototype, {
    setup() {
        super.setup(...arguments);
        this.offlinePlugin = usePlugin(OfflinePlugin);
    },

    /**
     * Only CRM rows subscribe to connectivity, so an open menu updates its
     * row and counters on disconnection.
     *
     * @param {Object} group activity group of the systray menu
     * @returns {boolean} whether the group is the CRM one and the connection is lost
     */
    isCrmGroupOffline(group) {
        return group.model === "crm.lead" && this.offlinePlugin.isOffline();
    },

    availableViews(group) {
        if (group.model === "crm.lead") {
            return [
                [false, "list"],
                [false, "kanban"],
                [false, "form"],
                [false, "calendar"],
                [false, "pivot"],
                [false, "graph"],
                [false, "activity"],
            ];
        }
        return super.availableViews(...arguments);
    },

    openActivityGroup(group, filter = "all", newWindow) {
        // fetch the data from the button otherwise fetch the ones from the parent (.o_ActivityMenuView_activityGroup).
        const context = {};
        if (group.model === "crm.lead") {
            // My Activities needs the server; stop before closing the menu or
            // loading the action, including direct calls.
            if (this.offlinePlugin.isOffline()) {
                return;
            }
            this.dropdown.close();
            if (filter === "my" || filter === "all") {
                context["search_default_activities_overdue"] = 1;
                context["search_default_activities_today"] = 1;
            } else if (filter === "overdue") {
                context["search_default_activities_overdue"] = 1;
            } else if (filter === "today") {
                context["search_default_activities_today"] = 1;
            } else {
                context["search_default_activities_upcoming_all"] = 1;
            }
            // Necessary because activity_ids of mail.activity.mixin has auto_join
            // So, duplicates are faking the count and "Load more" doesn't show up
            context["force_search_count"] = 1;
            this.action.loadAction("crm.crm_lead_action_my_activities").then((action) => {
                // to show lost leads in the activity
                action.domain = Domain.and([
                    action.domain || [],
                    [["active", "in", [true, false]]],
                ]).toList();
                this.action.doAction(action, {
                    newWindow,
                    additionalContext: context,
                    clearBreadcrumbs: true,
                });
            });
        } else {
            return super.openActivityGroup(...arguments);
        }
    },
});
