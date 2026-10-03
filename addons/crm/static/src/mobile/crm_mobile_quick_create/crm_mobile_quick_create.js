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
 * @property {number|false} stage_id id of an offered stage, false when none is offered
 */

function trimmed(value) {
    return String(value ?? "").trim();
}

/**
 * Collects the six-field mobile lead draft and delegates persistence to `onSave`.
 * The opener supplies action context and owns online/offline policy; no onchange
 * is needed. Save requires a nonempty name and an offered stage, closes on
 * resolution and preserves the draft on rejection; `onSave` resolving `false`
 * refuses the stage. Opened only by the small-screen pipeline.
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

    /** Stage select (`t-ref="this.stageRef"`), focused when Save refuses its value. */
    stageRef = signal(null);

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
            invalidStage: false,
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

    onNameInput() {
        this.state.invalidName = false;
    }

    onStageChange() {
        this.state.invalidStage = false;
    }

    flagInvalidStage() {
        this.state.invalidStage = true;
        this.stageRef()?.focus();
    }

    /**
     * Validates the name and the stage, then hands the six values to `onSave` and
     * closes the sheet once it resolves, unless with `false` (stage refused). A
     * second Save while one is running is ignored.
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
        const { stages } = this.props;
        const stage = stages.find(({ id }) => id === this.state.stage_id);
        if (stages.length && !stage) {
            this.flagInvalidStage();
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
            stage_id: stage ? stage.id : false,
        };
        this.state.isSaving = true;
        let accepted;
        try {
            accepted = await this.props.onSave(values);
        } catch (error) {
            if (status(this) !== "destroyed") {
                this.state.isSaving = false;
            }
            throw error;
        }
        if (status(this) === "destroyed") {
            return;
        }
        if (accepted === false) {
            this.state.isSaving = false;
            this.flagInvalidStage();
            return;
        }
        this.props.close?.();
    }

    /**
     * Form submission (Save button, or Enter on the phone keyboard).
     *
     * @param {SubmitEvent} [ev]
     * @returns {Promise<void>}
     */
    onSubmit(ev) {
        ev?.preventDefault();
        return this.onSave();
    }

    onCancel() {
        this.props.close?.();
    }
}
