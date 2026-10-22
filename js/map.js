"use strict";

/* ==========================================================
   1. 数据文件路径与基础配置
   ========================================================== */
const FILES = {
    districts: "data/DCD_gdb_DCD_converted.geojson",
    other: "data/FEHD_FL_FEHD_FL_converted.geojson",
    restaurants: "data/FEHD_RL_FEHD_RL_converted.geojson"
};

const COLORS = {
    restaurant: "#ff3b5c",
    other: "#ffae26",
    district: "#42f5d4"
};

const PALETTES = {
    neonSunset: ["#431525", "#80213b", "#bf3150", "#ef5a49", "#ff9f32", "#ffe07a", "#fff1b0"],
    cyberTeal: ["#102c2b", "#14514d", "#167b71", "#19a991", "#2bd2ad", "#63efcb", "#b9ffe9"],
    retroGold: ["#32160f", "#63301a", "#955025", "#c8732c", "#e99a35", "#f7c458", "#ffe5a2"],
    magentaNight: ["#28112f", "#531743", "#842056", "#b82b69", "#e23d79", "#ff6a99", "#ffb3c8"],
    diverging: ["#0f625d", "#28a99a", "#8bd7c7", "#3a2721", "#d28735", "#f2b84b", "#ffe39a"]
};

const state = {
    mode: "points",
    restaurants: true,
    other: true,
    districtBase: true,
    type: "all",
    district: "all",
    metric: "total",
    palette: "neonSunset",
    classMethod: "quantile",
    classCount: 5,
    fillOpacity: 0.62,
    boundaryGlow: 2
};

let map;
let infoWindow;
let districtGeoJSON;
let records = [];
let filteredRecords = [];
let districtStats = new Map();

let massMarks = null;
let heatMap = null;
let thematicOverlays = [];

/* 永久行政区底图与名称，切换专题模式时不删除 */
let districtBaseOverlays = [];
let districtLabelOverlays = [];

window.addEventListener("DOMContentLoaded", initializeMap);


/* ==========================================================
   2. 初始化地图与加载数据
   ========================================================== */
async function initializeMap() {
    try {
        map = new AMap.Map("map", {
            zoom: 10.4,
            center: [114.1694, 22.3193],
            viewMode: "2D",
            mapStyle: "amap://styles/wine",
            showLabel: true
        });

        map.addControl(new AMap.Scale());
        map.addControl(new AMap.ToolBar({ position: { right: "14px", top: "14px" } }));

        infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -7) });
        bindInterfaceEvents();

        const [districts, otherFood, restaurants] = await Promise.all([
            loadGeoJSON(FILES.districts),
            loadGeoJSON(FILES.other),
            loadGeoJSON(FILES.restaurants)
        ]);

        validateDistrictGeoJSON(districts);
        districtGeoJSON = convertDistrictsToGCJ02(districts);

        records = [
            ...cleanPointFeatures(restaurants.features, "restaurant"),
            ...cleanPointFeatures(otherFood.features, "other")
        ];

        createPermanentDistrictBase();
        populateFilters();
        applyFilters();

        setDataStatus(
            `✓ Loaded ${districtGeoJSON.features.length} districts and ${records.length.toLocaleString()} premises.`,
            true
        );

        $("loading").style.display = "none";
    } catch (error) {
        $("loading").style.display = "none";
        setDataStatus("✕ GeoJSON loading failed.", false);
        showError(`${error.message}\nCheck the data filenames and refresh with Ctrl+F5.`);
        console.error(error);
    }
}

async function loadGeoJSON(path) {
    const response = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });

    if (!response.ok) {
        throw new Error(`Cannot load ${path}: HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) {
        throw new Error(`${path} is not a valid GeoJSON FeatureCollection.`);
    }

    return data;
}

function validateDistrictGeoJSON(featureCollection) {
    if (!featureCollection.features.length) {
        throw new Error("District GeoJSON contains no features.");
    }

    const coordinate = firstCoordinate(featureCollection.features[0]?.geometry);

    if (!coordinate || !Number.isFinite(+coordinate[0]) || !Number.isFinite(+coordinate[1])) {
        throw new Error("District GeoJSON contains invalid coordinates.");
    }

    if (Math.abs(+coordinate[0]) > 180 || Math.abs(+coordinate[1]) > 90) {
        throw new Error(`District coordinates are not WGS84: ${coordinate}.`);
    }
}


/* ==========================================================
   3. 坐标与字段处理
   ========================================================== */
function convertDistrictsToGCJ02(featureCollection) {
    return {
        type: "FeatureCollection",
        features: featureCollection.features.map(feature => ({
            ...feature,
            geometry: transformGeometry(feature.geometry)
        }))
    };
}

function transformGeometry(geometry) {
    if (!geometry) return geometry;

    return {
        ...geometry,
        coordinates: walkCoordinates(
            geometry.coordinates,
            coordinate => wgs84ToGCJ02(+coordinate[0], +coordinate[1])
        )
    };
}

function walkCoordinates(value, transformFunction) {
    if (Array.isArray(value) && value.length >= 2 && typeof value[0] === "number") {
        return transformFunction(value);
    }

    return Array.isArray(value)
        ? value.map(item => walkCoordinates(item, transformFunction))
        : value;
}

function firstCoordinate(geometry) {
    let result = null;

    (function visit(value) {
        if (result) return;

        if (Array.isArray(value) && typeof value[0] === "number") {
            result = value;
        } else if (Array.isArray(value)) {
            value.forEach(visit);
        }
    })(geometry?.coordinates);

    return result;
}

function cleanPointFeatures(features, group) {
    return features
        .filter(feature => feature?.geometry?.type === "Point")
        .map(feature => {
            const properties = feature.properties || {};
            const coordinate = wgs84ToGCJ02(
                +feature.geometry.coordinates[0],
                +feature.geometry.coordinates[1]
            );

            return {
                lng: coordinate[0],
                lat: coordinate[1],
                group,
                properties,
                type: properties.NAME_EN || properties.NAME_TC || "Unclassified",
                district: normalizeDistrictName(
                    properties.SEARCH01_EN || properties.SEARCH01_TC || ""
                )
            };
        })
        .filter(record => Number.isFinite(record.lng) && Number.isFinite(record.lat));
}

function normalizeDistrictName(name) {
    const original = String(name || "").trim();
    const key = original
        .toLowerCase()
        .replace(/[‐‑‒–—-]/g, " ")
        .replace(/\//g, " and ")
        .replace(/\s+/g, " ")
        .replace(/ district$/i, "")
        .trim();

    const names = {
        "central and western": "Central and Western",
        "中西區": "Central and Western",
        "wan chai": "Wan Chai",
        "灣仔區": "Wan Chai",
        "eastern": "Eastern",
        "東區": "Eastern",
        "southern": "Southern",
        "南區": "Southern",
        "yau tsim mong": "Yau Tsim Mong",
        "油尖旺區": "Yau Tsim Mong",
        "sham shui po": "Sham Shui Po",
        "深水埗區": "Sham Shui Po",
        "kowloon city": "Kowloon City",
        "九龍城區": "Kowloon City",
        "wong tai sin": "Wong Tai Sin",
        "黃大仙區": "Wong Tai Sin",
        "kwun tong": "Kwun Tong",
        "觀塘區": "Kwun Tong",
        "kwai tsing": "Kwai Tsing",
        "葵青區": "Kwai Tsing",
        "tsuen wan": "Tsuen Wan",
        "荃灣區": "Tsuen Wan",
        "tuen mun": "Tuen Mun",
        "屯門區": "Tuen Mun",
        "yuen long": "Yuen Long",
        "元朗區": "Yuen Long",
        "north": "North",
        "北區": "North",
        "tai po": "Tai Po",
        "大埔區": "Tai Po",
        "sha tin": "Sha Tin",
        "沙田區": "Sha Tin",
        "sai kung": "Sai Kung",
        "西貢區": "Sai Kung",
        "islands": "Islands",
        "離島區": "Islands"
    };

    return names[key] || names[original] || original;
}

function getBoundaryName(feature) {
    const properties = feature.properties || {};
    return normalizeDistrictName(
        properties.NAME_EN || properties.NAME || properties.NAME_TC || ""
    );
}


/* ==========================================================
   4. 永久行政区底图与名称
   ========================================================== */
function createPermanentDistrictBase() {
    if (districtBaseOverlays.length) map.remove(districtBaseOverlays);
    if (districtLabelOverlays.length) map.remove(districtLabelOverlays);

    districtBaseOverlays = [];
    districtLabelOverlays = [];

    districtGeoJSON.features.forEach(feature => {
        const name = getBoundaryName(feature);

        geometryPaths(feature.geometry).forEach(path => {
            districtBaseOverlays.push(
                new AMap.Polygon({
                    path,
                    strokeColor: COLORS.district,
                    strokeWeight: 1.4,
                    strokeOpacity: 0.78,
                    fillColor: "#123d38",
                    fillOpacity: 0.025,
                    zIndex: 65,
                    bubble: true,
                    cursor: "default"
                })
            );
        });

        districtLabelOverlays.push(
            new AMap.Text({
                text: name,
                position: visualCenter(feature),
                anchor: "center",
                style: {
                    background: "rgba(16, 9, 8, 0.74)",
                    border: "1px solid rgba(66, 245, 212, 0.40)",
                    borderRadius: "3px",
                    padding: "2px 5px",
                    color: "#c9fff3",
                    fontFamily: '"DM Mono", monospace',
                    fontSize: "8px",
                    fontWeight: "500",
                    lineHeight: "12px",
                    textAlign: "center",
                    boxShadow: "0 0 6px rgba(66, 245, 212, 0.22)",
                    pointerEvents: "none"
                },
                zIndex: 145
            })
        );
    });

    updateDistrictBaseVisibility();
}

function updateDistrictBaseVisibility() {
    if (state.districtBase) {
        map.add(districtBaseOverlays);
        map.add(districtLabelOverlays);
    } else {
        map.remove(districtBaseOverlays);
        map.remove(districtLabelOverlays);
    }
}

function bringDistrictLabelsToFront() {
    if (!state.districtBase || !districtLabelOverlays.length) return;
    map.remove(districtLabelOverlays);
    map.add(districtLabelOverlays);
}


/* ==========================================================
   5. 界面事件、筛选与统计
   ========================================================== */
function bindInterfaceEvents() {
    document.querySelectorAll(".mode-btn").forEach(button => {
        button.addEventListener("click", () => {
            state.mode = button.dataset.mode;
            document.querySelectorAll(".mode-btn").forEach(item => {
                item.classList.toggle("active", item === button);
            });
            renderCurrentMode();
        });
    });

    $("showRestaurants").addEventListener("change", event => {
        state.restaurants = event.target.checked;
        applyFilters();
    });

    $("showOther").addEventListener("change", event => {
        state.other = event.target.checked;
        applyFilters();
    });

    $("showDistrictBase").addEventListener("change", event => {
        state.districtBase = event.target.checked;
        updateDistrictBaseVisibility();
    });

    $("typeFilter").addEventListener("change", event => {
        state.type = event.target.value;
        applyFilters();
    });

    $("districtFilter").addEventListener("change", event => {
        state.district = event.target.value;
        applyFilters();
    });

    $("metricSelect").addEventListener("change", event => {
        state.metric = event.target.value;
        renderCurrentMode();
    });

    $("paletteSelect").addEventListener("change", event => {
        state.palette = event.target.value;
        renderCurrentMode();
    });

    $("classMethod").addEventListener("change", event => {
        state.classMethod = event.target.value;
        renderCurrentMode();
    });

    $("classCount").addEventListener("input", event => {
        state.classCount = +event.target.value;
        $("classCountValue").textContent = event.target.value;
        renderCurrentMode();
    });

    $("fillOpacity").addEventListener("input", event => {
        state.fillOpacity = +event.target.value / 100;
        $("fillOpacityValue").textContent = `${event.target.value}%`;
        renderCurrentMode();
    });

    $("boundaryGlow").addEventListener("input", event => {
        state.boundaryGlow = +event.target.value;
        $("glowValue").textContent = (+event.target.value).toFixed(1);
        renderCurrentMode();
    });

    $("resetBtn").addEventListener("click", resetApplication);
}

function populateFilters() {
    fillSelect("typeFilter", [...new Set(records.map(record => record.type))].sort());
    fillSelect(
        "districtFilter",
        [...new Set(districtGeoJSON.features.map(getBoundaryName).filter(Boolean))].sort()
    );
}

function fillSelect(id, values) {
    values.forEach(value => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        $(id).appendChild(option);
    });
}

function applyFilters() {
    filteredRecords = records.filter(record => {
        const layerVisible = record.group === "restaurant"
            ? state.restaurants
            : state.other;

        return layerVisible
            && (state.type === "all" || record.type === state.type)
            && (state.district === "all" || record.district === state.district);
    });

    calculateDistrictStatistics();
    updateDashboard();
    renderCurrentMode();
}

function calculateDistrictStatistics() {
    districtStats = new Map();

    filteredRecords.forEach(record => {
        if (!districtStats.has(record.district)) {
            districtStats.set(record.district, emptyStatistics());
        }

        const statistics = districtStats.get(record.district);
        statistics.total += 1;
        statistics[record.group] += 1;
    });

    districtStats.forEach(statistics => {
        statistics.share = statistics.total
            ? statistics.restaurant / statistics.total * 100
            : 0;
    });
}

function updateDashboard() {
    setNumber("totalCount", filteredRecords.length);
    setNumber(
        "restaurantCount",
        filteredRecords.filter(record => record.group === "restaurant").length
    );
    setNumber(
        "otherCount",
        filteredRecords.filter(record => record.group === "other").length
    );

    const topDistricts = [...districtStats]
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 5);

    const maximum = topDistricts[0]?.[1].total || 1;

    $("ranking").innerHTML = topDistricts.map(([name, statistics], index) => `
        <div class="rank-row">
            <span class="rank-no">0${index + 1}</span>
            <span>
                ${escapeHTML(name)}
                <div class="rank-bar">
                    <i style="width:${statistics.total / maximum * 100}%"></i>
                </div>
            </span>
            <span class="rank-val">${statistics.total.toLocaleString()}</span>
        </div>
    `).join("");
}

function resetApplication() {
    Object.assign(state, {
        mode: "points",
        restaurants: true,
        other: true,
        districtBase: true,
        type: "all",
        district: "all",
        metric: "total",
        palette: "neonSunset",
        classMethod: "quantile",
        classCount: 5,
        fillOpacity: 0.62,
        boundaryGlow: 2
    });

    $("showRestaurants").checked = true;
    $("showOther").checked = true;
    $("showDistrictBase").checked = true;

    ["typeFilter", "districtFilter", "metricSelect", "paletteSelect", "classMethod"]
        .forEach(id => { $(id).selectedIndex = 0; });

    $("classCount").value = 5;
    $("fillOpacity").value = 62;
    $("boundaryGlow").value = 2;
    $("classCountValue").textContent = "5";
    $("fillOpacityValue").textContent = "62%";
    $("glowValue").textContent = "2.0";

    document.querySelectorAll(".mode-btn").forEach(button => {
        button.classList.toggle("active", button.dataset.mode === "points");
    });

    map.setZoomAndCenter(10.4, [114.1694, 22.3193]);
    updateDistrictBaseVisibility();
    applyFilters();
}


/* ==========================================================
   6. 专题图层管理与渲染
   ========================================================== */
function clearThematicLayers() {
    if (massMarks) {
        massMarks.setMap(null);
        massMarks = null;
    }

    if (heatMap) {
        heatMap.setMap(null);
        heatMap = null;
    }

    if (thematicOverlays.length) {
        map.remove(thematicOverlays);
        thematicOverlays = [];
    }

    infoWindow.close();
}

function renderCurrentMode() {
    if (!map || !districtGeoJSON) return;

    clearThematicLayers();

    const modeText = {
        points: ["POINT DISTRIBUTION", "Individual licensed premises", "Point mode locates individual licensed premises."],
        heat: ["HEAT MAP", "Spatial concentration", "Warmer colours indicate denser clusters."],
        bubble: ["BUBBLE MAP", "District magnitude", "Bubble size compares the selected district metric."],
        choropleth: ["CHOROPLETH", "District variation", "Colour compares the selected metric across districts."]
    }[state.mode];

    $("mapModeTitle").textContent = modeText[0];
    $("mapModeSubtitle").textContent = modeText[1];
    $("insightText").textContent = modeText[2];

    $("metricSelect").disabled = !["bubble", "choropleth"].includes(state.mode);
    $("symbologyPanel").classList.toggle("disabled", state.mode !== "choropleth");

    const renderers = {
        points: renderPoints,
        heat: renderHeatMap,
        bubble: renderBubbleMap,
        choropleth: renderChoropleth
    };

    renderers[state.mode]();
    updateLegend();

    /* 让行政区名称始终处于专题图层上方 */
    bringDistrictLabelsToFront();
}

function renderPoints() {
    const styles = [
        {
            url: markerDataURI(COLORS.restaurant),
            anchor: new AMap.Pixel(5, 5),
            size: new AMap.Size(10, 10)
        },
        {
            url: markerDataURI(COLORS.other),
            anchor: new AMap.Pixel(5, 5),
            size: new AMap.Size(10, 10)
        }
    ];

    massMarks = new AMap.MassMarks(
        filteredRecords.map(record => ({
            lnglat: [record.lng, record.lat],
            style: record.group === "restaurant" ? 0 : 1,
            record
        })),
        { zIndex: 130, opacity: 0.82, style: styles }
    );

    massMarks.on("click", event => openPointPopup(event.data.record, event.lnglat));
    massMarks.setMap(map);
}

function markerDataURI(color) {
    return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12">
            <circle cx="6" cy="6" r="4.7" fill="${color}" stroke="#ffe7c7" stroke-width="1"/>
        </svg>
    `);
}

function renderHeatMap() {
    heatMap = new AMap.HeatMap(map, {
        radius: 25,
        opacity: [0, 0.86],
        gradient: {
            0.10: "#351518",
            0.35: "#92243a",
            0.65: "#ff3b5c",
            0.82: "#ff8928",
            1.00: "#fff1a8"
        }
    });

    heatMap.setDataSet({
        data: filteredRecords.map(record => ({
            lng: record.lng,
            lat: record.lat,
            count: 1
        })),
        max: Math.max(8, Math.ceil(filteredRecords.length / 650))
    });
}

function renderBubbleMap() {
    const maximum = Math.max(
        ...[...districtStats.values()].map(statistics => statistics[state.metric] || 0),
        1
    );

    const fitOverlays = [];

    districtGeoJSON.features.forEach(feature => {
        const name = getBoundaryName(feature);
        const statistics = districtStats.get(name) || emptyStatistics();
        const value = statistics[state.metric] || 0;

        if ((state.district !== "all" && name !== state.district) || value <= 0) return;

        const center = visualCenter(feature);
        const radius = state.metric === "share"
            ? 8 + value * 0.27
            : 7 + Math.sqrt(value / maximum) * 31;

        const bubble = new AMap.CircleMarker({
            center,
            radius,
            strokeColor: "#f6d8b2",
            strokeWeight: 1,
            fillColor: state.metric === "share"
                ? continuousColor(value, 100)
                : COLORS.restaurant,
            fillOpacity: 0.66,
            zIndex: 160,
            cursor: "pointer"
        });

        bubble.on("click", () => openDistrictPopup(name, statistics, center));

        const valueLabel = new AMap.Text({
            text: formatMetric(value),
            position: center,
            anchor: "center",
            style: {
                background: "rgba(21, 9, 8, 0.78)",
                border: "1px solid rgba(255, 174, 38, 0.35)",
                padding: "2px 4px",
                color: "#ffe8cc",
                fontSize: "9px",
                textAlign: "center"
            },
            zIndex: 161
        });

        thematicOverlays.push(bubble, valueLabel);
        fitOverlays.push(bubble);
    });

    map.add(thematicOverlays);
    if (fitOverlays.length) map.setFitView(fitOverlays, false, [55, 55, 55, 55], 11);
}

function renderChoropleth() {
    const rows = districtGeoJSON.features
        .map(feature => {
            const name = getBoundaryName(feature);
            const statistics = districtStats.get(name) || emptyStatistics();
            return { feature, name, statistics, value: statistics[state.metric] || 0 };
        })
        .filter(row => state.district === "all" || row.name === state.district);

    const positiveValues = rows
        .map(row => row.value)
        .filter(value => Number.isFinite(value) && value > 0);

    const breaks = makeBreaks(positiveValues, state.classCount, state.classMethod);
    const palette = PALETTES[state.palette];
    const fitOverlays = [];

    rows.forEach(({ feature, name, statistics, value }) => {
        geometryPaths(feature.geometry).forEach(path => {
            const classNumber = classIndex(value, breaks);
            const fillColor = value > 0
                ? palette[Math.round(classNumber * (palette.length - 1) / Math.max(1, breaks.length - 1))]
                : "#21100f";

            const polygon = new AMap.Polygon({
                path,
                strokeColor: COLORS.district,
                strokeWeight: state.boundaryGlow,
                strokeOpacity: 0.96,
                fillColor,
                fillOpacity: value > 0 ? state.fillOpacity : 0.13,
                cursor: "pointer",
                zIndex: 120,
                bubble: true
            });

            polygon.on("mouseover", () => {
                polygon.setOptions({
                    strokeColor: "#b9fff0",
                    strokeWeight: state.boundaryGlow + 1,
                    fillOpacity: Math.min(0.9, state.fillOpacity + 0.14)
                });
            });

            polygon.on("mouseout", () => {
                polygon.setOptions({
                    strokeColor: COLORS.district,
                    strokeWeight: state.boundaryGlow,
                    fillOpacity: value > 0 ? state.fillOpacity : 0.13
                });
            });

            polygon.on("click", () => {
                openDistrictPopup(name, statistics, visualCenter(feature));
            });

            thematicOverlays.push(polygon);
            fitOverlays.push(polygon);
        });
    });

    map.add(thematicOverlays);
    if (fitOverlays.length) map.setFitView(fitOverlays, false, [35, 35, 35, 35], 11);
}


/* ==========================================================
   7. 分级、几何与图例
   ========================================================== */
function makeBreaks(values, classCount, method) {
    if (!values.length) return [0];

    const sorted = [...values].sort((a, b) => a - b);
    const minimum = sorted[0];
    const maximum = sorted[sorted.length - 1];

    if (minimum === maximum) return [maximum];

    const breaks = [];

    if (method === "equal") {
        for (let index = 1; index <= classCount; index += 1) {
            breaks.push(minimum + (maximum - minimum) * index / classCount);
        }
    } else {
        for (let index = 1; index <= classCount; index += 1) {
            const position = (sorted.length - 1) * index / classCount;
            const lower = Math.floor(position);
            const upper = Math.ceil(position);
            const quantile = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
            breaks.push(quantile);
        }
    }

    return [...new Set(
        breaks.map(value => +value.toFixed(state.metric === "share" ? 1 : 0))
    )];
}

function classIndex(value, breaks) {
    if (value <= 0) return 0;
    const index = breaks.findIndex(limit => value <= limit);
    return index < 0 ? breaks.length - 1 : index;
}

function geometryPaths(geometry) {
    if (!geometry?.coordinates) return [];

    if (geometry.type === "Polygon") {
        return [geometry.coordinates.map(ring => ring.map(coordinate => [+coordinate[0], +coordinate[1]]))];
    }

    if (geometry.type === "MultiPolygon") {
        return geometry.coordinates.map(polygon =>
            polygon.map(ring => ring.map(coordinate => [+coordinate[0], +coordinate[1]]))
        );
    }

    return [];
}

function visualCenter(feature) {
    const polygons = feature.geometry.type === "MultiPolygon"
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];

    const largest = polygons.reduce((current, candidate) =>
        ringArea(candidate[0]) > ringArea(current[0]) ? candidate : current,
        polygons[0]
    );

    const ring = largest[0];
    let area = 0;
    let x = 0;
    let y = 0;

    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
        const a = ring[previous];
        const b = ring[index];
        const cross = a[0] * b[1] - b[0] * a[1];
        area += cross;
        x += (a[0] + b[0]) * cross;
        y += (a[1] + b[1]) * cross;
    }

    if (Math.abs(area) < 1e-12) return ring[Math.floor(ring.length / 2)];
    return [x / (3 * area), y / (3 * area)];
}

function ringArea(ring) {
    let area = 0;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
        area += ring[previous][0] * ring[index][1] - ring[index][0] * ring[previous][1];
    }
    return Math.abs(area / 2);
}

function continuousColor(value, maximum) {
    const palette = PALETTES.neonSunset;
    const ratio = Math.max(0, Math.min(1, value / maximum));
    return palette[Math.min(palette.length - 1, Math.floor(ratio * palette.length))];
}

function updateLegend() {
    const element = $("legend");

    if (state.mode === "points") {
        element.innerHTML = `
            <div class="section-label">LEGEND</div>
            <div class="legend-row"><i class="legend-dot" style="width:9px;height:9px;background:${COLORS.restaurant}"></i>Restaurant licences</div>
            <div class="legend-row"><i class="legend-dot" style="width:9px;height:9px;background:${COLORS.other}"></i>Other food licences</div>
            <div class="legend-row"><i class="legend-dot" style="width:12px;height:2px;border-radius:0;background:${COLORS.district}"></i>District boundary</div>
        `;
        return;
    }

    if (state.mode === "bubble") {
        element.innerHTML = `
            <div class="section-label">${metricName()}</div>
            <div class="legend-row"><i class="legend-dot" style="width:10px;height:10px;background:${COLORS.restaurant}"></i>Lower</div>
            <div class="legend-row"><i class="legend-dot" style="width:24px;height:24px;background:${COLORS.restaurant}"></i>Higher</div>
        `;
        return;
    }

    if (state.mode === "heat") {
        element.innerHTML = `
            <div class="section-label">DENSITY</div>
            <div class="gradient"></div>
            <div class="legend-scale"><span>LOW</span><span>HIGH</span></div>
        `;
        return;
    }

    const values = [...districtStats.values()]
        .map(statistics => statistics[state.metric] || 0)
        .filter(value => value > 0);

    const breaks = makeBreaks(values, state.classCount, state.classMethod);
    const palette = PALETTES[state.palette];
    let lowerLimit = 0;

    element.innerHTML = `
        <div class="section-label">${metricName()}</div>
        <div class="boundary-sample"></div>
        <div class="legend-caption">Fluorescent district boundary</div>
        ${breaks.map((upperLimit, index) => {
            const color = palette[
                Math.round(index * (palette.length - 1) / Math.max(1, breaks.length - 1))
            ];
            const label = `${formatBreak(lowerLimit)} – ${formatBreak(upperLimit)}`;
            lowerLimit = upperLimit;
            return `<div class="class-chip"><i style="background:${color}"></i><span>${label}</span></div>`;
        }).join("")}
        <div class="legend-caption">
            ${state.classMethod === "quantile" ? "Quantile" : "Equal interval"} · ${breaks.length} classes
        </div>
    `;
}


/* ==========================================================
   8. 信息窗口与实用函数
   ========================================================== */
function openPointPopup(record, position) {
    const properties = record.properties;

    infoWindow.setContent(`
        <div class="popup">
            <h3>${escapeHTML(properties.NSEARCH03_EN || properties.NAME_EN || "Licensed Premise")}</h3>
            <div class="en">${escapeHTML(properties.NSEARCH03_TC || properties.NAME_TC || "")}</div>
            <p><b>Licence:</b> ${escapeHTML(properties.NAME_EN || properties.NAME_TC || "")}</p>
            <p><b>Address:</b> ${escapeHTML(properties.ADDRESS_EN || properties.ADDRESS_TC || "")}</p>
            <p><b>District:</b> ${escapeHTML(record.district)}</p>
            <p><b>Licence No.:</b> ${escapeHTML(properties.SEARCH02_EN || properties.SEARCH02_TC || "")}</p>
        </div>
    `);

    infoWindow.open(map, position);
}

function openDistrictPopup(name, statistics, position) {
    infoWindow.setContent(`
        <div class="popup">
            <h3>${escapeHTML(name)}</h3>
            <p><b>Total premises:</b> ${statistics.total.toLocaleString()}</p>
            <p><b>Restaurants:</b> ${statistics.restaurant.toLocaleString()}</p>
            <p><b>Other food:</b> ${statistics.other.toLocaleString()}</p>
            <p><b>Restaurant share:</b> ${statistics.share.toFixed(1)}%</p>
        </div>
    `);

    infoWindow.open(map, position);
}

function metricName() {
    return {
        total: "TOTAL PREMISES",
        restaurant: "RESTAURANTS",
        other: "OTHER FOOD",
        share: "RESTAURANT SHARE"
    }[state.metric];
}

function formatMetric(value) {
    return state.metric === "share"
        ? `${value.toFixed(1)}%`
        : Math.round(value).toLocaleString();
}

function formatBreak(value) {
    return state.metric === "share"
        ? `${value.toFixed(1)}%`
        : Math.round(value).toLocaleString();
}

function emptyStatistics() {
    return { total: 0, restaurant: 0, other: 0, share: 0 };
}

function $(id) {
    return document.getElementById(id);
}

function setNumber(id, value) {
    $(id).textContent = value.toLocaleString();
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>'"]/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;"
    })[character]);
}

function setDataStatus(text, success) {
    const element = $("dataStatus");
    element.textContent = text;
    element.className = `data-note ${success ? "ok" : "bad"}`;
}

function showError(text) {
    const element = $("errorBox");
    element.hidden = false;
    element.textContent = text;
}


/* ==========================================================
   9. WGS84 转 GCJ-02
   ========================================================== */
function wgs84ToGCJ02(lng, lat) {
    if (outsideChina(lng, lat)) return [lng, lat];

    let deltaLat = transformLatitude(lng - 105, lat - 35);
    let deltaLng = transformLongitude(lng - 105, lat - 35);
    const radianLat = lat / 180 * Math.PI;
    let magic = Math.sin(radianLat);
    magic = 1 - 0.00669342162296594323 * magic * magic;
    const sqrtMagic = Math.sqrt(magic);

    deltaLat = deltaLat * 180 /
        ((6378245 * (1 - 0.00669342162296594323)) / (magic * sqrtMagic) * Math.PI);

    deltaLng = deltaLng * 180 /
        (6378245 / sqrtMagic * Math.cos(radianLat) * Math.PI);

    return [lng + deltaLng, lat + deltaLat];
}

function outsideChina(lng, lat) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLatitude(x, y) {
    let result = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    result += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    result += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
    result += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
    return result;
}

function transformLongitude(x, y) {
    let result = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    result += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    result += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
    result += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
    return result;
}
