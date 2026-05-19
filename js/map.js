let mapInstance = null;
let baseMapLayer = null;
let satMapLayer = null;
let currentBaseLayer = null;

// RainViewer Animation State
let radarFrames = [];
let radarLayers = [];
let currentFrameIndex = 0;
let animationTimer = null;
let isPlaying = false;

const MapService = {
    initMap(lat, lon) {
        if (!mapInstance) {
            // Initialize map
            mapInstance = L.map('radar-map').setView([lat, lon], 7);

            // Light Map (CartoDB Positron)
            baseMapLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
                subdomains: 'abcd',
                maxZoom: 20
            });

            // Satellite Map (ESRI World Imagery)
            satMapLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                attribution: 'Tiles &copy; Esri',
                maxZoom: 20
            });

            // Default Base Layer
            currentBaseLayer = baseMapLayer;
            currentBaseLayer.addTo(mapInstance);
            
            // Add a marker for the current location
            this.marker = L.marker([lat, lon]).addTo(mapInstance);
            
            // Bind UI toggles
            this.bindToggles();
            
            // Fetch and setup RainViewer animation
            this.setupRainViewer();
        } else {
            this.updateMap(lat, lon);
        }
    },

    bindToggles() {
        const mapBtn = document.getElementById('toggle-map');
        const satBtn = document.getElementById('toggle-sat');
        const playBtn = document.getElementById('toggle-play');

        // Base Map Toggles
        if (mapBtn && satBtn) {
            mapBtn.addEventListener('click', () => {
                if (currentBaseLayer !== baseMapLayer) {
                    mapInstance.removeLayer(currentBaseLayer);
                    currentBaseLayer = baseMapLayer;
                    currentBaseLayer.addTo(mapInstance);
                    // Ensure radar stays on top
                    radarLayers.forEach(l => l.bringToFront());
                    mapBtn.classList.add('active');
                    satBtn.classList.remove('active');
                }
            });

            satBtn.addEventListener('click', () => {
                if (currentBaseLayer !== satMapLayer) {
                    mapInstance.removeLayer(currentBaseLayer);
                    currentBaseLayer = satMapLayer;
                    currentBaseLayer.addTo(mapInstance);
                    // Ensure radar stays on top
                    radarLayers.forEach(l => l.bringToFront());
                    satBtn.classList.add('active');
                    mapBtn.classList.remove('active');
                }
            });
        }

        // Animation Toggle
        if (playBtn) {
            playBtn.addEventListener('click', () => {
                if (isPlaying) {
                    this.stopAnimation();
                } else {
                    this.startAnimation();
                }
            });
        }
    },

    async setupRainViewer() {
        const timeDisplay = document.getElementById('radar-time');
        if (timeDisplay) timeDisplay.textContent = 'Loading radar...';

        try {
            const response = await fetch('https://api.rainviewer.com/public/weather-maps.json');
            const data = await response.json();
            
            // We'll use past radar frames. Grab the last 8 frames to not overload the map
            radarFrames = data.radar.past.slice(-8); 

            // Create tile layers for each frame
            radarLayers = radarFrames.map((frame, index) => {
                const layer = L.tileLayer(`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
                    opacity: 0,
                    zIndex: 10 + index, // ensure they sit on top of base map
                    transparent: true,
                    maxNativeZoom: 7
                });
                layer.addTo(mapInstance);
                return layer;
            });

            // Set initial state (show last frame)
            currentFrameIndex = radarLayers.length - 1;
            this.showFrame(currentFrameIndex);

        } catch (error) {
            console.error('Failed to load RainViewer data:', error);
            if (timeDisplay) timeDisplay.textContent = 'Radar Error';
        }
    },

    showFrame(index) {
        if (!radarLayers.length) return;
        
        // Hide all frames
        radarLayers.forEach(layer => layer.setOpacity(0));
        
        // Show current frame
        radarLayers[index].setOpacity(0.7); // 0.7 opacity to see base map through it

        // Update time display
        const timeDisplay = document.getElementById('radar-time');
        if (timeDisplay) {
            const frameTime = new Date(radarFrames[index].time * 1000);
            timeDisplay.textContent = frameTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
    },

    startAnimation() {
        if (!radarLayers.length) return;
        
        isPlaying = true;
        const playBtn = document.getElementById('toggle-play');
        if (playBtn) {
            playBtn.classList.add('active');
            playBtn.innerHTML = '<i data-lucide="pause"></i>';
            lucide.createIcons();
        }

        animationTimer = setInterval(() => {
            currentFrameIndex++;
            if (currentFrameIndex >= radarLayers.length) {
                currentFrameIndex = 0; // loop back
            }
            this.showFrame(currentFrameIndex);
        }, 800); // 800ms per frame
    },

    stopAnimation() {
        isPlaying = false;
        clearInterval(animationTimer);
        const playBtn = document.getElementById('toggle-play');
        if (playBtn) {
            playBtn.classList.remove('active');
            playBtn.innerHTML = '<i data-lucide="play"></i>';
            lucide.createIcons();
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
        }
    }
};
