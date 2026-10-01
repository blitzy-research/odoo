import { onWillStart, useEffect } from "@odoo/owl";
import { user } from "@web/core/user";
import { RottingColumnProgress } from "@mail/js/rotting_mixin/rotting_column_progress";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";

export class CrmColumnProgress extends RottingColumnProgress {
    static template = "crm.ColumnProgress";
    setup() {
        // `super.setup()` provides `this.offlinePlugin` (web `ColumnProgress`), the only
        // connectivity source read here.
        super.setup();
        // Result of the `crm.group_use_recurring_revenues` probe. Visibility is derived from
        // it by the `showRecurringRevenue` getter, which must not be assigned (getter-only).
        this.hasRecurringRevenueGroup = false;
        // True when the probe could not run because the connection was lost: the effect
        // below then issues it once, on the first online render.
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
                // A connection lost during the probe hides the aggregate instead of failing
                // the column, and defers the probe to the reconnection; online, no
                // ConnectionLostError occurs, so the online result and errors are unchanged.
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
     * Whether the recurring-revenue (MRR) aggregate is rendered. PART 2 #5, SKIP offline: no
     * `has_group` request is issued and no MRR node is rendered while offline.
     *
     * Reading the `isOffline` signal during render subscribes the component, so a column
     * mounted online hides the aggregate as soon as the connection drops and shows it again
     * on reconnection, without a remount. Online, the value equals the probe result.
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
