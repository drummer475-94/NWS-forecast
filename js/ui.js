let ambientCanvas = null;
let ambientCtx = null;
let ambientAnimId = null;
let ambientParticles = [];
let currentTheme = '';

const UI = {
    // Determine Lucide icon based on short forecast string
    getWeatherIcon(shortForecast, isDaytime = true) {
        const text = shortForecast.toLowerCase();
        if (text.includes('thunderstorm') || text.includes('t-storm')) return 'cloud-lightning';
        if (text.includes('snow') || text.includes('blizzard') || text.includes('flurry')) return 'snowflake';
        if (text.includes('rain') || text.includes('shower') || text.includes('drizzle') || text.includes('sleet')) return 'cloud-rain';
        if (text.includes('fog') || text.includes('mist') || text.includes('haze')) return 'cloud-fog';
        if (text.includes('cloudy') || text.includes('overcast')) {
            if (text.includes('partly') || text.includes('mostly')) return isDaytime ? 'cloud-sun' : 'cloud-moon';
            return 'cloud';
        }
        if (text.includes('wind') || text.includes('breezy') || text.includes('gusty')) return 'wind';
        return isDaytime ? 'sun' : 'moon';
    },

    // Convert Celsius to Fahrenheit
    celsiusToFahrenheit(c) {
        return Math.round((c * 9/5) + 32);
    },

    calculateFeelsLike(tempF, humidity, windSpeedStr) {
        let windMph = 0;
        if (windSpeedStr) {
            const match = windSpeedStr.match(/(\d+)/);
            if (match) windMph = parseInt(match[1], 10);
        }
        
        if (tempF <= 50 && windMph > 3) {
            return Math.round(35.74 + 0.6215 * tempF - 35.75 * Math.pow(windMph, 0.16) + 0.4275 * tempF * Math.pow(windMph, 0.16));
        }
        if (tempF >= 80 && humidity !== null && humidity !== undefined) {
            const t = tempF;
            const rh = humidity;
            const hi = -42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh - 0.00683783 * t * t - 0.05481717 * rh * rh + 0.00122874 * t * t * rh + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;
            return Math.round(hi);
        }
        return tempF;
    },

    renderCurrentConditions(locationName, forecastData, hourlyData) {
        document.getElementById('location-name').textContent = locationName;
        
        const current = forecastData.properties.periods[0]; // Currently or rest of today
        const isDaytime = current.isDaytime;

        document.getElementById('current-temp').textContent = `${current.temperature}°${current.temperatureUnit}`;
        document.getElementById('current-desc').textContent = current.shortForecast;
        
        // Update Icon
        const iconName = this.getWeatherIcon(current.shortForecast, isDaytime);
        const iconElement = document.getElementById('current-icon');
        iconElement.setAttribute('data-lucide', iconName);
        
        // Details
        document.getElementById('current-wind').textContent = `${current.windSpeed} ${current.windDirection}`;
        
        // Probability of precipitation (can be null)
        const pop = current.probabilityOfPrecipitation?.value || 0;
        document.getElementById('current-precip').textContent = `${pop}%`;

        // Humidity, Feels Like
        let humidity = '--';
        let feelsLike = `${current.temperature}°${current.temperatureUnit}`;
        let rawHumidity = null;
        
        if (hourlyData && hourlyData.properties && hourlyData.properties.periods && hourlyData.properties.periods.length > 0) {
            const hourlyCurrent = hourlyData.properties.periods[0];
            
            if (hourlyCurrent.relativeHumidity && hourlyCurrent.relativeHumidity.value !== null) {
                rawHumidity = hourlyCurrent.relativeHumidity.value;
                humidity = `${Math.round(rawHumidity)}%`;
                
                if (current.temperatureUnit === 'F') {
                    const fl = this.calculateFeelsLike(current.temperature, rawHumidity, current.windSpeed);
                    feelsLike = `${fl}°F`;
                }
            }
        }
        
        const humidityEl = document.getElementById('current-humidity');
        if (humidityEl) humidityEl.textContent = humidity;
        
        const feelsLikeEl = document.getElementById('current-feels-like');
        if (feelsLikeEl) feelsLikeEl.textContent = feelsLike;

        // Trigger background theme update
        this.setAmbientTheme(current.shortForecast, isDaytime);

        // Re-initialize Lucide icons to apply the newly set data-lucide attribute
        lucide.createIcons();

        document.getElementById('current-conditions').classList.remove('hidden');
    },

    renderForecast(forecastData) {
        const container = document.getElementById('forecast-container');
        container.innerHTML = ''; // Clear previous

        const periods = forecastData.properties.periods;
        
        // Filter out only daytime periods for the 7-day overview, or night if it's currently night for the first one
        const dailyForecasts = periods.filter(p => p.isDaytime || p.name.includes("Night") === false);
        
        // Ensure we only show about 7 items
        const itemsToShow = dailyForecasts.slice(0, 7);

        itemsToShow.forEach(period => {
            const iconName = this.getWeatherIcon(period.shortForecast, period.isDaytime);
            const pop = period.probabilityOfPrecipitation?.value || 0;

            const el = document.createElement('div');
            el.className = 'forecast-item';
            el.innerHTML = `
                <div class="forecast-day">${period.name}</div>
                <i data-lucide="${iconName}" class="forecast-icon"></i>
                <div class="forecast-temp">${period.temperature}°${period.temperatureUnit}</div>
                <div class="forecast-desc" title="${period.shortForecast}">${period.shortForecast}</div>
                <div class="forecast-precip">
                    <i data-lucide="droplets"></i> ${pop}%
                </div>
            `;
            container.appendChild(el);
        });

        lucide.createIcons();
        document.getElementById('forecast-section').classList.remove('hidden');
    },

    renderHourlyForecast(hourlyData) {
        const container = document.getElementById('hourly-container');
        if (!container) return;
        container.innerHTML = ''; // Clear previous

        if (!hourlyData || !hourlyData.properties || !hourlyData.properties.periods) {
            document.getElementById('hourly-section').classList.add('hidden');
            return;
        }

        const periods = hourlyData.properties.periods.slice(0, 24); // next 24 hours

        periods.forEach(period => {
            const time = new Date(period.startTime);
            const formattedTime = time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const iconName = this.getWeatherIcon(period.shortForecast, period.isDaytime);
            const pop = period.probabilityOfPrecipitation?.value || 0;

            const el = document.createElement('div');
            el.className = 'hourly-item forecast-item';
            el.innerHTML = `
                <div class="hourly-time">${formattedTime}</div>
                <i data-lucide="${iconName}" class="forecast-icon" style="width: 28px; height: 28px;"></i>
                <div class="forecast-temp" style="font-size: 1.1rem;">${period.temperature}°${period.temperatureUnit}</div>
                <div class="forecast-desc" style="font-size: 0.75rem; min-height: 2.2rem;" title="${period.shortForecast}">${period.shortForecast}</div>
                <div class="forecast-precip" style="font-size: 0.75rem;">
                    <i data-lucide="droplets" style="width: 12px; height: 12px;"></i> ${pop}%
                </div>
            `;
            container.appendChild(el);
        });

        lucide.createIcons();
        document.getElementById('hourly-section').classList.remove('hidden');
    },

    renderAlerts(alertsData) {
        const banner = document.getElementById('alerts-banner');
        const content = document.getElementById('alerts-banner-content');
        if (!banner || !content) return;

        // Hide by default
        banner.classList.add('hidden');
        banner.className = 'alerts-banner hidden'; // reset alert severity styles

        if (!alertsData || !alertsData.features || alertsData.features.length === 0) {
            return;
        }

        const activeAlerts = alertsData.features.filter(f => f.properties.status === 'Actual');
        if (activeAlerts.length === 0) return;

        // Get the most severe alert first
        const mainAlert = activeAlerts[0].properties;
        const count = activeAlerts.length;

        // Style depending on severity: Extreme, Severe, Moderate, Minor
        const severity = mainAlert.severity;
        banner.classList.remove('hidden');
        banner.classList.add(`alert-${severity.toLowerCase()}`);

        content.innerHTML = `<i data-lucide="alert-triangle" class="alert-icon"></i> 
            <strong>${mainAlert.event}</strong> in effect for ${mainAlert.areaDesc.split(';')[0]} 
            ${count > 1 ? `(+${count - 1} more alert${count > 2 ? 's' : ''})` : ''} 
            — Click for details`;

        lucide.createIcons();

        // Bind click to open Modal
        banner.onclick = () => {
            this.openAlertModal(activeAlerts);
        };
    },

    openAlertModal(alerts) {
        const modal = document.getElementById('alert-modal');
        const titleEl = document.getElementById('modal-alert-title');
        const severityEl = document.getElementById('modal-alert-severity');
        const urgencyEl = document.getElementById('modal-alert-urgency');
        const instEl = document.getElementById('modal-alert-instruction');
        const descEl = document.getElementById('modal-alert-desc');

        if (!modal) return;

        // Load the primary active alert details
        const alertProp = alerts[0].properties;

        titleEl.textContent = alertProp.event;
        
        severityEl.textContent = `Severity: ${alertProp.severity}`;
        severityEl.className = `alert-tag alert-severity-${alertProp.severity.toLowerCase()}`;

        urgencyEl.textContent = `Urgency: ${alertProp.urgency}`;
        urgencyEl.className = `alert-tag alert-urgency-${alertProp.urgency.toLowerCase()}`;

        instEl.innerHTML = alertProp.instruction 
            ? `<h4>Safety Instructions:</h4><p>${alertProp.instruction.replace(/\n/g, '<br>')}</p>`
            : '';

        descEl.innerHTML = `<h4>Detailed Description:</h4><p>${alertProp.description.replace(/\n/g, '<br>')}</p>`;

        modal.classList.remove('hidden');

        // Bind Close clicks
        const closeBtn = document.getElementById('close-modal-btn');
        closeBtn.onclick = () => modal.classList.add('hidden');
        modal.onclick = (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        };
    },

    initAmbient() {
        ambientCanvas = document.getElementById('weather-ambient-canvas');
        if (!ambientCanvas) return;
        ambientCtx = ambientCanvas.getContext('2d');

        const resizeCanvas = () => {
            ambientCanvas.width = window.innerWidth;
            ambientCanvas.height = window.innerHeight;
        };
        
        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();
    },

    setAmbientTheme(shortForecast, isDaytime) {
        this.initAmbient();
        if (!ambientCanvas || !ambientCtx) return;

        const text = shortForecast.toLowerCase();
        let targetTheme = 'clear-day';

        if (text.includes('thunderstorm') || text.includes('t-storm')) {
            targetTheme = 'thunderstorm';
        } else if (text.includes('snow') || text.includes('blizzard') || text.includes('flurry')) {
            targetTheme = 'snow';
        } else if (text.includes('rain') || text.includes('shower') || text.includes('drizzle') || text.includes('sleet')) {
            targetTheme = 'rain';
        } else if (text.includes('cloudy') || text.includes('overcast') || text.includes('fog') || text.includes('mist')) {
            targetTheme = isDaytime ? 'cloudy-day' : 'cloudy-night';
        } else {
            targetTheme = isDaytime ? 'clear-day' : 'clear-night';
        }

        // Apply theme class to body
        document.body.className = '';
        document.body.classList.add(`theme-${targetTheme}`);

        if (currentTheme === targetTheme) return; // theme unchanged, continue running animation
        currentTheme = targetTheme;

        // Cancel existing animation
        if (ambientAnimId) {
            cancelAnimationFrame(ambientAnimId);
            ambientAnimId = null;
        }

        // Setup particles based on theme
        ambientParticles = [];
        let pCount = 30; // moderate particle count for performance

        if (targetTheme === 'rain' || targetTheme === 'thunderstorm') {
            pCount = 50;
            for (let i = 0; i < pCount; i++) {
                ambientParticles.push({
                    x: Math.random() * ambientCanvas.width,
                    y: Math.random() * ambientCanvas.height,
                    length: 10 + Math.random() * 15,
                    speed: 12 + Math.random() * 8,
                    opacity: 0.15 + Math.random() * 0.25
                });
            }
        } else if (targetTheme === 'snow') {
            pCount = 40;
            for (let i = 0; i < pCount; i++) {
                ambientParticles.push({
                    x: Math.random() * ambientCanvas.width,
                    y: Math.random() * ambientCanvas.height,
                    radius: 1.5 + Math.random() * 3,
                    speed: 0.8 + Math.random() * 1.2,
                    density: Math.random() * 20,
                    opacity: 0.2 + Math.random() * 0.4
                });
            }
        } else if (targetTheme.includes('cloudy')) {
            pCount = 8;
            for (let i = 0; i < pCount; i++) {
                ambientParticles.push({
                    x: Math.random() * ambientCanvas.width,
                    y: Math.random() * ambientCanvas.height,
                    radius: 80 + Math.random() * 120,
                    speed: 0.2 + Math.random() * 0.3,
                    opacity: 0.05 + Math.random() * 0.05,
                    dx: Math.random() > 0.5 ? 1 : -1
                });
            }
        } else if (targetTheme === 'clear-day') {
            // Warm radiating waves pulse from the top-right corner
            pCount = 3;
            for (let i = 0; i < pCount; i++) {
                ambientParticles.push({
                    scale: 0.8 + i * 0.4,
                    speed: 0.001 + Math.random() * 0.001,
                    direction: 1
                });
            }
        } else if (targetTheme === 'clear-night') {
            // Twinkling stars
            pCount = 40;
            for (let i = 0; i < pCount; i++) {
                ambientParticles.push({
                    x: Math.random() * ambientCanvas.width,
                    y: Math.random() * ambientCanvas.height,
                    radius: 0.8 + Math.random() * 1.2,
                    twinkleSpeed: 0.01 + Math.random() * 0.02,
                    opacity: Math.random()
                });
            }
        }

        // Particle drawing loop
        const draw = () => {
            if (!ambientCanvas || !ambientCtx) return;
            ambientCtx.clearRect(0, 0, ambientCanvas.width, ambientCanvas.height);

            const w = ambientCanvas.width;
            const h = ambientCanvas.height;

            if (targetTheme === 'rain' || targetTheme === 'thunderstorm') {
                // Lightning trigger in thunderstorms
                if (targetTheme === 'thunderstorm' && Math.random() > 0.985) {
                    ambientCtx.fillStyle = 'rgba(255, 255, 255, 0.15)';
                    ambientCtx.fillRect(0, 0, w, h);
                }

                ambientCtx.lineWidth = 1;
                ambientCtx.lineCap = 'round';
                
                ambientParticles.forEach(p => {
                    ambientCtx.strokeStyle = `rgba(174, 219, 255, ${p.opacity})`;
                    ambientCtx.beginPath();
                    ambientCtx.moveTo(p.x, p.y);
                    ambientCtx.lineTo(p.x - 2, p.y + p.length);
                    ambientCtx.stroke();

                    // update position
                    p.y += p.speed;
                    p.x -= 2;
                    if (p.y > h) {
                        p.y = -p.length;
                        p.x = Math.random() * w;
                    }
                });
            } else if (targetTheme === 'snow') {
                ambientParticles.forEach(p => {
                    ambientCtx.fillStyle = `rgba(255, 255, 255, ${p.opacity})`;
                    ambientCtx.beginPath();
                    ambientCtx.arc(p.x, p.y, p.radius, 0, Math.PI * 2, true);
                    ambientCtx.fill();

                    // snow float math
                    p.y += p.speed;
                    p.x += Math.sin(p.density) * 0.5;
                    p.density += 0.01;

                    if (p.y > h) {
                        p.y = -10;
                        p.x = Math.random() * w;
                    }
                });
            } else if (targetTheme.includes('cloudy')) {
                ambientParticles.forEach(p => {
                    let grad = ambientCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius);
                    grad.addColorStop(0, `rgba(200, 200, 210, ${p.opacity})`);
                    grad.addColorStop(1, 'rgba(200, 200, 210, 0)');
                    ambientCtx.fillStyle = grad;
                    ambientCtx.beginPath();
                    ambientCtx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                    ambientCtx.fill();

                    // slow cloud drift
                    p.x += p.speed * p.dx;
                    if (p.dx > 0 && p.x - p.radius > w) {
                        p.x = -p.radius;
                    } else if (p.dx < 0 && p.x + p.radius < 0) {
                        p.x = w + p.radius;
                    }
                });
            } else if (targetTheme === 'clear-day') {
                // Soft golden pulsing circles in top corner
                ambientParticles.forEach(p => {
                    p.scale += p.speed * p.direction;
                    if (p.scale > 1.2 || p.scale < 0.7) {
                        p.direction *= -1;
                    }
                    let rad = Math.min(w, h) * 0.4 * p.scale;
                    let grad = ambientCtx.createRadialGradient(w * 0.9, h * 0.1, 0, w * 0.9, h * 0.1, rad);
                    grad.addColorStop(0, 'rgba(255, 223, 128, 0.08)');
                    grad.addColorStop(0.5, 'rgba(255, 223, 128, 0.03)');
                    grad.addColorStop(1, 'rgba(255, 223, 128, 0)');
                    
                    ambientCtx.fillStyle = grad;
                    ambientCtx.beginPath();
                    ambientCtx.arc(w * 0.9, h * 0.1, rad, 0, Math.PI * 2);
                    ambientCtx.fill();
                });
            } else if (targetTheme === 'clear-night') {
                // Twinkling stars
                ambientParticles.forEach(p => {
                    p.opacity += p.twinkleSpeed;
                    if (p.opacity > 1 || p.opacity < 0.1) {
                        p.twinkleSpeed *= -1;
                    }
                    ambientCtx.fillStyle = `rgba(255, 255, 255, ${p.opacity * 0.7})`;
                    ambientCtx.beginPath();
                    ambientCtx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                    ambientCtx.fill();
                });
            }

            ambientAnimId = requestAnimationFrame(draw);
        };

        draw();
    },

    showLoading(show) {
        const overlay = document.getElementById('loading-overlay');
        if (show) {
            overlay.classList.remove('hidden');
            document.getElementById('current-conditions').classList.add('hidden');
            document.getElementById('forecast-section').classList.add('hidden');
            const hs = document.getElementById('hourly-section');
            if (hs) hs.classList.add('hidden');
        } else {
            overlay.classList.add('hidden');
        }
    },

    showError(msg) {
        const errEl = document.getElementById('search-error');
        if (msg) {
            errEl.textContent = msg;
            errEl.classList.remove('hidden');
        } else {
            errEl.classList.add('hidden');
            errEl.textContent = '';
        }
    }
};
