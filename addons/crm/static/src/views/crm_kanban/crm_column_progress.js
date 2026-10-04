import { onWillStart, useEffect } from "@odoo/owl";
import { user } from "@web/core/user";
import { RottingColumnProgress } from "@mail/js/rotting_mixin/rotting_column_progress";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";

export class CrmColumnProgress extends RottingColumnProgress {
    static template = "crm.ColumnProgress";
    setup() {
        super.setup();
        this.hasRecurringRevenueGroup = false;
        this.crmRecurringProbePending = false;
        const rrField = this.props.progressBarState.progressAttributes.recurring_revenue_sum_field;

        onWillStart(async () => {
            if (!rrField) {
                return;
            }
            if (this.offlinePlugin.isOffline()) {
                // Advisory read: neither issued nor queued offline.
                this.crmRecurringProbePending = true;
                return;
            }
            try {
                this.hasRecurringRevenueGroup = await user.hasGroup(
                    "crm.group_use_recurring_revenues"
                );
            } catch (error) {
                // Only ConnectionLostError hides MRR and defers the advisory probe; rethrow every
                // other error.
                if (!(error instanceof ConnectionLostError)) {
                    throw error;
                }
                this.crmRecurringProbePending = true;
            }
        });

        useEffect(() => {
            // Read the signal first and unconditionally, so that the effect re-runs on every
            // connectivity change. At setup the probe is never pending (onWillStart sets the
            // flag later), so this does nothing for a component mounted online.
            const offline = this.offlinePlugin.isOffline();
            if (offline || !this.crmRecurringProbePending) {
                return;
            }
            this.crmRecurringProbePending = false;
            // The probe starts in a microtask, outside this effect's tracking, and accepts
            // a synchronous `user.hasGroup` result as well as a promise.
            Promise.resolve()
                .then(() => user.hasGroup("crm.group_use_recurring_revenues"))
                .then((hasGroup) => {
                    this.hasRecurringRevenueGroup = hasGroup;
                    this.render();
                })
                .catch((error) => {
                    if (error instanceof ConnectionLostError) {
                        // Lost again: retry on the next reconnection.
                        this.crmRecurringProbePending = true;
                        return;
                    }
                    throw error;
                });
        });
    }

    /**
     * MRR is visible only with cached group access and a live connection; the connectivity signal
     * updates an already-mounted column.
     *
     * @returns {boolean}
     */
    get showRecurringRevenue() {
        return this.hasRecurringRevenueGroup && !this.offlinePlugin.isOffline();
    }

    getRecurringRevenueGroupAggregate(group) {
        if (!this.showRecurringRevenue) {
            return {};
        }
        const rrField = this.props.progressBarState.progressAttributes.recurring_revenue_sum_field;
        return this.props.progressBarState.getAggregateValue(group, rrField);
    }

    getColumnProgressTooltip(bar) {
        const barString = typeof bar.value === 'symbol' ? _t('Without activities scheduled') : bar.string;
        return `${bar.count} ${barString}`;
    }
}
