import type { TaskCtx, TaskResult } from "./types";
import { extractErrorMessage } from "../extract-error";

const NEW_ORLEANS_FALLBACK = { lat: 30.0395, lng: -90.0702 };
const SEARCH_RADIUS_METERS = 5000;
const MAX_RESULTS = 10;

interface PlacesResult {
  name: string;
  vicinity?: string;
  formatted_address?: string;
  geometry?: { location: { lat: number; lng: number } };
  rating?: number;
  user_ratings_total?: number;
  price_level?: number;
  place_id?: string;
}

function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

export async function runDaycycleConnect(tc: TaskCtx): Promise<TaskResult> {
  const { business, env, supabase, taskRunId, emit, cfLocation } = tc;

  // Feature flag: Google Cloud billing required before Places API is enabled
  if (env.DAYCYCLE_PLACES_ENABLED !== "true") {
    await emit({ type: "cmd", text: "DayCycle location discovery staged (Places API not yet enabled)", ts: Date.now() });
    try {
      await supabase.from("business_assets").insert({
        business_id: business.id,
        task_run_id: taskRunId,
        asset_type: "daycycle_locations",
        asset_subtype: "disabled",
        asset_data: {
          locations: [],
          center: null,
          location_source: "disabled",
          setup_required: "google_cloud_billing",
        },
        is_current: true,
        metadata: { flag: "DAYCYCLE_PLACES_ENABLED=false" },
      });
    } catch {
      // Non-fatal — placeholder write failure does not block build
    }
    return {
      output_data: {
        location_count: 0,
        location_source: "disabled",
        setup_required: "google_cloud_billing",
      },
    };
  }

  await emit({ type: "cmd", text: "Geolocating user from request headers", ts: Date.now() });

  // 1. Determine location: prefer Cloudflare IP geolocation threaded from the
  //    stream handler, fall back to New Orleans default for V1
  let center = { ...NEW_ORLEANS_FALLBACK };
  let locationSource: "cloudflare_ip" | "fallback" = "fallback";

  if (cfLocation) {
    center = cfLocation;
    locationSource = "cloudflare_ip";
  }

  await emit({
    type: "cmd",
    text: `Querying Google Places: cafes within ${SEARCH_RADIUS_METERS}m of ${center.lat.toFixed(3)},${center.lng.toFixed(3)} (${locationSource})`,
    ts: Date.now(),
  });

  // 2. Call Google Places Nearby Search
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_API_KEY not configured");
  }

  const placesUrl = new URL(
    "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
  );
  placesUrl.searchParams.set("location", `${center.lat},${center.lng}`);
  placesUrl.searchParams.set("radius", String(SEARCH_RADIUS_METERS));
  placesUrl.searchParams.set("type", "cafe");
  placesUrl.searchParams.set("key", apiKey);

  let placesResponse: Response;
  try {
    placesResponse = await fetch(placesUrl.toString());
  } catch (err) {
    throw new Error(`Places API fetch failed: ${extractErrorMessage(err)}`);
  }

  if (!placesResponse.ok) {
    throw new Error(`Places API returned ${placesResponse.status}`);
  }

  const placesJson = (await placesResponse.json()) as {
    status: string;
    results?: PlacesResult[];
    error_message?: string;
  };

  if (placesJson.status !== "OK" && placesJson.status !== "ZERO_RESULTS") {
    throw new Error(
      `Places API status=${placesJson.status}` +
        (placesJson.error_message ? `: ${placesJson.error_message}` : ""),
    );
  }

  // 3. Map results to our shape, sorted by distance
  const rawResults = placesJson.results ?? [];
  const locations = rawResults
    .filter((p) => p.geometry?.location)
    .map((p) => {
      const lat = p.geometry!.location.lat;
      const lng = p.geometry!.location.lng;
      return {
        name: p.name,
        address: p.vicinity || p.formatted_address || "",
        distance_meters: haversineMeters(center.lat, center.lng, lat, lng),
        rating: p.rating ?? null,
        user_ratings_total: p.user_ratings_total ?? null,
        price_level: p.price_level ?? null,
        lat,
        lng,
        place_id: p.place_id ?? null,
      };
    })
    .sort((a, b) => a.distance_meters - b.distance_meters)
    .slice(0, MAX_RESULTS);

  await emit({
    type: "cmd",
    text: `Found ${locations.length} cafes within ${SEARCH_RADIUS_METERS}m`,
    ts: Date.now(),
  });

  // 4. Write business_assets — failure here fails the task (no silent skip)
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "daycycle_locations",
      asset_subtype: null,
      asset_data: {
        locations,
        center,
        location_source: locationSource,
        search_type: "cafe",
        search_radius_meters: SEARCH_RADIUS_METERS,
      },
      is_current: true,
      metadata: {
        api: "google_places",
        endpoint: "nearbysearch",
        results_returned_by_api: rawResults.length,
        results_kept: locations.length,
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to write daycycle_locations asset: ${extractErrorMessage(err)}`,
    );
  }

  return {
    output_data: {
      location_count: locations.length,
      center,
      location_source: locationSource,
    },
  };
}
