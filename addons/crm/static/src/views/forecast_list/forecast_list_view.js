import { registry } from "@web/core/registry";
import { listView } from "@web/views/list/list_view";
import { ForecastSearchModel } from "@crm/views/forecast_search_model";
import { CrmListModel } from "@crm/views/crm_list/crm_list_view";

/**
 * Forecast list model: the lead list model (`CrmListModel`), so that its multi-edit
 * saves of leads are sent in their turn in the replay. It is never marked as visited.
 */
class ForecastListModel extends CrmListModel {
    /**
     * The forecast is never available offline: never mark it as visited.
     * @override
     */
    _setAvailableOffline() {}
}

export const forecastListView = {
    ...listView,
    Model: ForecastListModel,
    SearchModel: ForecastSearchModel,
};

registry.category("views").add("forecast_list", forecastListView);
