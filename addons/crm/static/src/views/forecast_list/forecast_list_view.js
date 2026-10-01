import { registry } from "@web/core/registry";
import { listView } from "@web/views/list/list_view";
import { ForecastSearchModel } from "@crm/views/forecast_search_model";

class ForecastListModel extends listView.Model {
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
