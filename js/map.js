let mapInstance = null;
let baseMapLayer = null;
let currentBaseLayer = null;

// RainViewer & Satellite Animation State
let currentOverlayMode = 'radar'; // 'radar', 'clouds', 'vapor'
let radarFrames = [];
let radarLayers = [];
let cloudFrames = [];
let cloudLayers = [];
let vaporLayer = null;

let currentFrameIndex = 0;
let animationTimer = null;
let isPlaying = false;

const MapService = {
    initMap(lat, lon) {
        if (!mapInstance) {
            // Initialize map with custom clean controls
            mapInstance = L.map('radar-map', {
                zoomControl: false
            }).setView([lat, lon], 7);

            // Add clean custom-positioned zoom control at bottom-right
            L.control.zoom({
                position: 'bottomright'
            }).addTo(mapInstance);

            // Sleek CartoDB Dark Matter Base Map layer
            baseMapLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
                subdomains: 'abcd',
                maxZoom: 20
            });

            // Default Base Layer
            currentBaseLayer = baseMapLayer;
            currentBaseLayer.addTo(mapInstance);
            
            // Add a marker for the current location
            this.marker = L.marker([lat, lon]).addTo(mapInstance);
            
            // Bind UI toggles
            this.bindToggles();
            
            // Update Legend UI on init
            this.updateLegendUI();

            // Fetch and setup RainViewer animation
            this.setupRainViewer();
        } else {
            this.updateMap(lat, lon);
        }
    },

    bindToggles() {
        const playBtn = document.getElementById('toggle-play');

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

        // Overlay Mode Toggles
        const radarBtn = document.getElementById('toggle-radar');
        const cloudsBtn = document.getElementById('toggle-clouds');
        const vaporBtn = document.getElementById('toggle-vapor');

        if (radarBtn && cloudsBtn && vaporBtn) {
            radarBtn.addEventListener('click', () => {
                currentOverlayMode = 'radar';
                radarBtn.classList.add('active');
                cloudsBtn.classList.remove('active');
                vaporBtn.classList.remove('active');
                this.updatePlayButtonState();
                this.updateLegendUI();
                this.showFrame(currentFrameIndex);
            });
            
            cloudsBtn.addEventListener('click', () => {
                currentOverlayMode = 'clouds';
                cloudsBtn.classList.add('active');
                radarBtn.classList.remove('active');
                vaporBtn.classList.remove('active');
                this.updatePlayButtonState();
                this.updateLegendUI();
                this.showFrame(currentFrameIndex);
            });
            
            vaporBtn.addEventListener('click', () => {
                currentOverlayMode = 'vapor';
                vaporBtn.classList.add('active');
                radarBtn.classList.remove('active');
                cloudsBtn.classList.remove('active');
                this.updatePlayButtonState();
                this.updateLegendUI();
                this.showFrame(currentFrameIndex);
            });
        }
    },

    updateLegendUI() {
        const titleEl = document.getElementById('legend-title');
        const gradEl = document.getElementById('legend-gradient');
        const labelsEl = document.getElementById('legend-labels');
        if (!titleEl || !gradEl || !labelsEl) return;

        if (currentOverlayMode === 'radar') {
            titleEl.textContent = 'Radar (dBZ)';
            gradEl.style.background = 'linear-gradient(to right, rgba(0,236,236,0.3) 0%, rgba(1,160,246,0.6) 20%, rgba(0,229,0,0.8) 40%, rgba(253,253,0,0.9) 60%, rgba(253,0,0,0.9) 80%, rgba(148,0,211,1) 100%)';
            labelsEl.innerHTML = '<span>Light</span><span>Moderate</span><span>Heavy</span>';
        } else if (currentOverlayMode === 'clouds') {
            titleEl.textContent = 'Clouds (Infrared)';
            gradEl.style.background = 'linear-gradient(to right, rgba(0,0,0,0.1) 0%, rgba(80,80,80,0.5) 30%, rgba(180,180,180,0.8) 60%, rgba(255,255,255,0.9) 80%, rgba(0,200,255,0.9) 100%)';
            labelsEl.innerHTML = '<span>Warm / Low</span><span>Cold / High</span>';
        } else if (currentOverlayMode === 'vapor') {
            titleEl.textContent = 'Water Vapor (GOES)';
            gradEl.style.background = 'linear-gradient(to right, rgba(64,0,64,0.7) 0%, rgba(0,0,255,0.7) 30%, rgba(0,255,255,0.7) 60%, rgba(255,255,255,0.7) 80%, rgba(255,255,0,0.7) 100%)';
            labelsEl.innerHTML = '<span>Dry (Sinking)</span><span>Moist (Rising)</span>';
        }
    },

    updatePlayButtonState() {
        const playBtn = document.getElementById('toggle-play');
        if (!playBtn) return;
        
        if (currentOverlayMode === 'vapor') {
            playBtn.setAttribute('disabled', 'true');
            playBtn.style.opacity = '0.4';
            playBtn.style.cursor = 'not-allowed';
            this.stopAnimation();
        } else {
            playBtn.removeAttribute('disabled');
            playBtn.style.opacity = '1';
            playBtn.style.cursor = 'pointer';
        }
    },

    async setupRainViewer() {
        const timeDisplay = document.getElementById('radar-time');
        if (timeDisplay) timeDisplay.textContent = 'Loading radar...';

        try {
            const response = await fetch('https://api.rainviewer.com/public/weather-maps.json');
            const data = await response.json();
            
            // Grab last 8 frames
            radarFrames = data.radar.past.slice(-8); 
            if (data.satellite && data.satellite.infrared) {
                cloudFrames = data.satellite.infrared.slice(-8);
            }

            // Create tile layers for radar
            radarLayers = radarFrames.map((frame, index) => {
                const layer = L.tileLayer(`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
                    opacity: 0,
                    zIndex: 10 + index,
                    transparent: true,
                    maxNativeZoom: 7
                });
                layer.addTo(mapInstance);
                return layer;
            });

            // Create tile layers for clouds
            if (cloudFrames.length > 0) {
                cloudLayers = cloudFrames.map((frame, index) => {
                    const layer = L.tileLayer(`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
                        opacity: 0,
                        zIndex: 10 + index,
                        transparent: true,
                        maxNativeZoom: 7
                    });
                    layer.addTo(mapInstance);
                    return layer;
                });
            }

            // Create GOES Water Vapor layer
            vaporLayer = L.tileLayer('https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/goes-east-wv-ch08/{z}/{x}/{y}.png', {
                opacity: 0,
                zIndex: 15,
                transparent: true,
                maxNativeZoom: 10
            });
            vaporLayer.addTo(mapInstance);

            // Set initial state (show last frame)
            currentFrameIndex = radarLayers.length - 1;
            this.showFrame(currentFrameIndex);

        } catch (error) {
            console.error('Failed to load RainViewer data:', error);
            if (timeDisplay) timeDisplay.textContent = 'Radar Error';
        }
    },

    showFrame(index) {
        // Hide all layers first
        radarLayers.forEach(layer => layer.setOpacity(0));
        cloudLayers.forEach(layer => layer.setOpacity(0));
        if (vaporLayer) vaporLayer.setOpacity(0);
        
        const timeDisplay = document.getElementById('radar-time');
        
        if (currentOverlayMode === 'radar') {
            if (!radarLayers.length) return;
            radarLayers[index].setOpacity(0.7);
            if (timeDisplay && radarFrames[index]) {
                const frameTime = new Date(radarFrames[index].time * 1000);
                timeDisplay.textContent = frameTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
        } else if (currentOverlayMode === 'clouds') {
            if (!cloudLayers.length) return;
            cloudLayers[index].setOpacity(0.65);
            if (timeDisplay && cloudFrames[index]) {
                const frameTime = new Date(cloudFrames[index].time * 1000);
                timeDisplay.textContent = frameTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
        } else if (currentOverlayMode === 'vapor') {
            if (vaporLayer) vaporLayer.setOpacity(0.65);
            if (timeDisplay) {
                timeDisplay.textContent = 'Real-time GOES-East';
            }
        }
    },

    startAnimation() {
        const layersToAnimate = currentOverlayMode === 'clouds' ? cloudLayers : radarLayers;
        if (!layersToAnimate.length) return;
        
        isPlaying = true;
        const playBtn = document.getElementById('toggle-play');
        if (playBtn) {
            playBtn.classList.add('active');
            playBtn.innerHTML = '<i data-lucide="pause"></i>';
            lucide.createIcons();
        }

        animationTimer = setInterval(() => {
            currentFrameIndex++;
            if (currentFrameIndex >= layersToAnimate.length) {
                currentFrameIndex = 0;
            }
            this.showFrame(currentFrameIndex);
        }, 800);
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
