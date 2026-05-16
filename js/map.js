let mapInstance = null;
let currentRadarLayer = null;
let hdRadarLayer = null;
let normalRadarLayer = null;

const MapService = {
    initMap(lat, lon) {
        if (!mapInstance) {
            // Initialize map
            mapInstance = L.map('radar-map').setView([lat, lon], 7);

            // Add light/white base map (CartoDB Positron) for readability
            L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
                subdomains: 'abcd',
                maxZoom: 20
            }).addTo(mapInstance);

            // HD Radar (Iowa Environmental Mesonet High-Res N0Q)
            hdRadarLayer = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi', {
                layers: 'nexrad-n0q-900913',
                format: 'image/png',
                transparent: true,
                attribution: 'Weather data © IEM',
                opacity: 0.7
            });

            // Normal Radar (Iowa Environmental Mesonet Standard N0R)
            normalRadarLayer = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r.cgi', {
                layers: 'nexrad-n0r-900913',
                format: 'image/png',
                transparent: true,
                attribution: 'Weather data © IEM',
                opacity: 0.7
            });

            // Default to HD radar
            currentRadarLayer = hdRadarLayer;
            currentRadarLayer.addTo(mapInstance);
            
            // Add a marker for the current location
            this.marker = L.marker([lat, lon]).addTo(mapInstance);
            
            // Bind toggles
            this.bindToggles();
        } else {
            this.updateMap(lat, lon);
        }
    },

    bindToggles() {
        const hdBtn = document.getElementById('toggle-hd-radar');
        const normalBtn = document.getElementById('toggle-normal-radar');

        if (!hdBtn || !normalBtn) return;

        hdBtn.addEventListener('click', () => {
            if (currentRadarLayer !== hdRadarLayer) {
                mapInstance.removeLayer(currentRadarLayer);
                currentRadarLayer = hdRadarLayer;
                currentRadarLayer.addTo(mapInstance);
                hdBtn.classList.add('active');
                normalBtn.classList.remove('active');
            }
        });

        normalBtn.addEventListener('click', () => {
            if (currentRadarLayer !== normalRadarLayer) {
                mapInstance.removeLayer(currentRadarLayer);
                currentRadarLayer = normalRadarLayer;
                currentRadarLayer.addTo(mapInstance);
                normalBtn.classList.add('active');
                hdBtn.classList.remove('active');
            }
        });
    },

    updateMap(lat, lon) {
        if (mapInstance) {
            mapInstance.setView([lat, lon], 7);
            if (this.marker) {
                this.marker.setLatLng([lat, lon]);
            } else {
                this.marker = L.marker([lat, lon]).addTo(mapInstance);
            }
            
            // Redraw active radar layer
            if (currentRadarLayer) {
                currentRadarLayer.redraw();
            }
        }
    }
};
