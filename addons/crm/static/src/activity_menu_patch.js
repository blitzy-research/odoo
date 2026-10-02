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
     * Read during render by the CRM `mail.ActivityMenu` extension template
     * (crm_mobile_pipeline.xml) to give the CRM row and its counters their
     * offline disabled state. Reading the offline signal during render
     * subscribes the menu, so one opened online re-renders when the
     * connectivity changes; the signal is read for the CRM row only.
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
