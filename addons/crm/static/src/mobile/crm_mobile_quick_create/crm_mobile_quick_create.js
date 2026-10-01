import { Component, proxy, signal, status } from "@odoo/owl";
import { uniqueId } from "@web/core/utils/functions";
import { useCrmOffline } from "@crm/mobile/crm_offline_hooks";

/**
 * Values handed to the opener's `onSave`. The keys are `crm.lead` field names and
 * become, unchanged, the `vals` of the `web_save` the opener issues or queues.
 *
 * @typedef {Object} CrmMobileQuickCreateValues
 * @property {string} name trimmed, never empty
 * @property {string} contact_name trimmed
 * @property {string} phone trimmed
 * @property {string} email_from trimmed
 * @property {number} expected_revenue finite number, 0 when left empty or invalid
 * @property {number|false} stage_id id of the selected stage
 */

/**
 * @param {unknown} value raw value bound to an input by `t-model`
 * @returns {string} the value as a trimmed string ("" for null or undefined)
 */
function trimmed(value) {
    return String(value ?? "").trim();
}

/**
 * Bottom-sheet quick create of the CRM mobile pipeline.
 *
 * It captures exactly six `crm.lead` fields (name, contact name, phone, email,
 * expected revenue and stage) and hands them to the opener's `onSave`. It issues no
 * request and touches no offline storage: the opener saves the values online or
 * queues them offline through `useCrmOffline().createLead()`, with the pipeline
 * context (`default_type: "opportunity"`) that supplies the type, team, salesperson
 * and company defaults on the server. No `onchange` is needed, so the sheet works
 * offline in every loaded stage.
 *
 * Like every CRM mobile component, it resolves the shared CRM offline hooks with
 * `useCrmOffline()` (exposed as `this.crmOffline`) and never imports the framework
 * offline plugin itself. Its only offline action, the create, still goes through
 * those hooks in the opener's `onSave`.
 *
 * It is opened only by the small-screen stage pipeline (its "New" button, or once on
 * mount for the "New Lead" PWA shortcut), through
 * `usePopover(CrmMobileQuickCreate, { useBottomSheet: true })`; `web.BottomSheet`
 * passes `close`.
 *
 * Save closes the sheet once `onSave` resolves. When `onSave` rejects (an online
 * server error), the sheet stays open with the entered values and the error is
 * rethrown, so the framework's RPC error handling displays it.
 *
 * @example
 * this.quickCreate = usePopover(CrmMobileQuickCreate, { useBottomSheet: true });
 * this.quickCreate.open(target, {
 *     stages: [{ id: 1, display_name: "New" }, { id: 2, display_name: "Qualified" }],
 *     defaultStageId: 2,
 *     onSave: (values) => this.crmOffline.createLead(this.props.list, values, extras),
 * });
 */
export class CrmMobileQuickCreate extends Component {
    static template = "crm.CrmMobileQuickCreate";
    static props = {
        stages: { type: Array },
        defaultStageId: { type: [Number, Boolean], optional: true },
        onSave: { type: Function },
        close: { type: Function, optional: true },
    };

    /**
     * Name input (`t-ref="this.nameRef"`). It is focused only when Save finds the
     * name empty: autofocus on open would raise the phone keyboard over the sheet's
     * slide-in animation.
     */
    nameRef = signal(null);

    setup() {
        this.crmOffline = useCrmOffline();
        // Unique per sheet, so each `<label for>` targets its own control even if
        // two sheets ever coexist.
        this.fieldIdPrefix = uniqueId("o_crm_mobile_quick_create_");
        this.state = proxy({
            name: "",
            contact_name: "",
            phone: "",
            email_from: "",
            expected_revenue: "",
            stage_id: this.props.defaultStageId || this.props.stages[0]?.id || false,
            invalidName: false,
            isSaving: false,
        });
    }

    /**
     * @param {string} name `crm.lead` field name
     * @returns {string} DOM id of that field's control, shared by its `<label for>`
     */
    fieldId(name) {
        return `${this.fieldIdPrefix}_${name}`;
    }

    /**
     * Clears the "name required" state as soon as the user types in the name.
     */
    onNameInput() {
        this.state.invalidName = false;
    }

    /**
     * Validates the name, then hands the six values to `onSave` and closes the
     * sheet once it resolves. A second Save while one is running is ignored.
     *
     * @returns {Promise<void>} rejects with `onSave`'s error, sheet left open
     */
    async onSave() {
        if (this.state.isSaving) {
            return;
        }
        const name = trimmed(this.state.name);
        if (!name) {
            this.state.invalidName = true;
            this.nameRef()?.focus();
            return;
        }
        const expectedRevenue = Number(this.state.expected_revenue);
        /** @type {CrmMobileQuickCreateValues} */
        const values = {
            name,
            contact_name: trimmed(this.state.contact_name),
            phone: trimmed(this.state.phone),
            email_from: trimmed(this.state.email_from),
            // NaN and Infinity would serialize as `null`: send 0 instead, as for
            // an empty input.
            expected_revenue: Number.isFinite(expectedRevenue) ? expectedRevenue : 0,
            stage_id: Number(this.state.stage_id) || false,
        };
        this.state.isSaving = true;
        try {
            await this.props.onSave(values);
        } catch (error) {
            // Keep the sheet open with the entered values and let the framework's
            // error handling show the server error.
            if (status(this) !== "destroyed") {
                this.state.isSaving = false;
            }
            throw error;
        }
        if (status(this) !== "destroyed") {
            this.props.close?.();
        }
    }

    /**
     * Form submission (Save button, or Enter on the phone keyboard).
     *
     * @param {SubmitEvent} [ev]
     * @returns {Promise<void>}
     */
    onSubmit(ev) {
        // Never let the browser submit the form: that would navigate away.
        ev?.preventDefault();
        return this.onSave();
    }

    /**
     * Closes the sheet without saving.
     */
    onCancel() {
        this.props.close?.();
    }
}
