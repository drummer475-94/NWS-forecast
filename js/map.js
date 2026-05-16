let mapInstance = null;
let radarLayer = null;

const MapService = {
    initMap(lat, lon) {
        if (!mapInstance) {
            // Initialize map
            mapInstance = L.map('radar-map').setView([lat, lon], 7);

            // Add dark mode base map (CartoDB Dark Matter)
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
                subdomains: 'abcd',
                maxZoom: 20
            }).addTo(mapInstance);

            // Add NWS RIDGE2 Radar WMS Layer
            radarLayer = L.tileLayer.wms('https://opengeo.ncep.noaa.gov/geoserver/conus/radar/ows?', {
                layers: 'conus_radar_base_reflectivity',
                format: 'image/png',
                transparent: true,
                attribution: 'NOAA/NWS',
                opacity: 0.7
            }).addTo(mapInstance);
            
            // Add a marker for the current location
            this.marker = L.marker([lat, lon]).addTo(mapInstance);
        } else {
            this.updateMap(lat, lon);
        }
    },

    updateMap(lat, lon) {
        if (mapInstance) {
            mapInstance.setView([lat, lon], 7);
            if (this.marker) {
                this.marker.setLatLng([lat, lon]);
            } else {
                this.marker = L.marker([lat, lon]).addTo(mapInstance);
            }
            
            // Force redraw of radar layer by updating params slightly (cache busting) if needed, 
            // but just moving the map is usually enough to fetch new tiles.
            radarLayer.redraw();
        }
    }
};
