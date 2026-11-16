// Dangerous group "pricing". Every call opens a double confirmation dialog on the user's computer.
// In-app purchase and subscription prices: use asc_request (group "raw").
import { z } from "zod";
import { enc, rel } from "../asc.mjs";

export default [
  {
    name: "set_app_price",
    group: "pricing",
    description:
      "Set the app's base price from a price point id (see list_price_points). Apple derives other territories from the base territory. startDate empty = now. Phrase: PRICE <app name> <customerPrice> <territory>.",
    input: {
      appId: z.string(),
      pricePointId: z.string(),
      baseTerritory: z.string().default("USA"),
      startDate: z.string().optional().describe("YYYY-MM-DD"),
    },
    confirm: async ({ appId, pricePointId, baseTerritory, startDate }, { api }) => {
      const app = (await api("GET", `/v1/apps/${enc(appId)}?fields[apps]=name`)).data.attributes.name;
      const pp = (
        await api("GET", `/v1/apps/${enc(appId)}/appPricePoints?filter[territory]=${enc(baseTerritory)}&limit=200`)
      ).data.find((p) => p.id === pricePointId);
      if (!pp)
        throw new Error(`price point ${pricePointId} not found for ${baseTerritory} (only the first 200 are checked)`);
      return {
        action: "Change app price",
        summary: [
          "Change app price:",
          `App: ${app} (${appId})`,
          `Base territory: ${baseTerritory}`,
          `Customer price: ${pp.attributes.customerPrice}`,
          `Proceeds: ${pp.attributes.proceeds}`,
          `Start: ${startDate ?? "now"}`,
        ],
        phrase: `PRICE ${app} ${pp.attributes.customerPrice} ${baseTerritory}`,
      };
    },
    run: async ({ appId, pricePointId, baseTerritory, startDate }, { api }) => {
      const r = await api("POST", "/v1/appPriceSchedules", {
        data: {
          type: "appPriceSchedules",
          relationships: {
            app: rel("apps", appId),
            baseTerritory: rel("territories", baseTerritory),
            manualPrices: { data: [{ type: "appPrices", id: "${price1}" }] },
          },
        },
        included: [
          {
            type: "appPrices",
            id: "${price1}",
            attributes: { startDate: startDate ?? null },
            relationships: { appPricePoint: rel("appPricePoints", pricePointId) },
          },
        ],
      });
      return { scheduleId: r.data.id, appId, pricePointId, baseTerritory, startDate: startDate ?? "now" };
    },
  },
];
