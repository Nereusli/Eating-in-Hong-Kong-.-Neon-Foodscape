# Eating in Hong Kong II · Neon Foodscape

## Quuick Access

https://nereusli.github.io/Eating-in-Hong-Kong-.-Neon-Foodscape/

<img width="1912" height="921" alt="image" src="https://github.com/user-attachments/assets/46cf16d1-6668-451d-bce4-a111ad65c977" />
<img width="1917" height="922" alt="image" src="https://github.com/user-attachments/assets/84e05fdf-69c1-4522-9004-5712f863a32f" />


## Data files

- `DCD_gdb_DCD_converted.geojson` (WGS84/EPSG:4326, coordinates around 114.x, 22.x)
- `FEHD_FL_FEHD_FL_converted.geojson`
- `FEHD_RL_FEHD_RL_converted.geojson`

## Run
```bash
python -m http.server 8000
```
Open `http://localhost:8000`, then use Ctrl+F5 once.

The Network/terminal log should show GET requests for all three GeoJSON files. This build adds cache-busting and `cache: no-store`, validates FeatureCollection and WGS84 coordinates, and displays a green data status in the dashboard.

## Visual optimization
The original Neon Foodscape layout and CSS are preserved. Choropleth borders are now thin amber rather than cyan, polygon opacity is reduced, hover highlighting is subtle, and bubble labels use the centroid of each district's largest polygon to avoid labels falling in the sea.

## Choropleth symbology controls
The control panel now includes five colour ramps, quantile/equal-interval classification, 3–7 classes, fill-opacity control, and fluorescent cyan boundary-glow control. The legend updates with class ranges.
