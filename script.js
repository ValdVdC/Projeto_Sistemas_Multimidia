    // ===== VARIÁVEIS GLOBAIS =====
    let audioSamples = {};
    let midiSynths = {};
    let reverb, filter;
    let isPlaying = false;
    let currentStep = 0;
    let sequenceInterval;
    let tempo = 120;
    let nextStepTime = 0; // Tempo da próxima nota
    let scheduleAheadTime = 0.1; // Agendar 100ms à frente
    
    // Player MIDI
    let audioContext;
    let loadedInstruments = {};
    let midiPlayer;
    let currentMIDIFile = null;
    let isPlayingMIDI = false;
    let currentInstruments = {1: 0, 2: 0};
    let audioEffectsChain; // Nó de entrada da cadeia de efeitos

    // Inicializar samples de áudio MP3 para o sequenciador
    function initAudioSamples() {
        // Carregar samples MP3
        audioSamples.kick = new Audio('sounds/kick.mp3');
        audioSamples.snare = new Audio('sounds/snare.mp3');
        audioSamples.hihat = new Audio('sounds/hihat.mp3');
        audioSamples.bass = new Audio('sounds/bass.mp3');
        
        // Pré-carregar os samples
        Object.values(audioSamples).forEach(audio => {
            audio.load();
            audio.volume = 0.7;
        });
    }

    // Inicializar player MIDI com reverb e efeitos
    async function initMIDISynths() {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        // Criar cadeia de efeitos profissionais
        // 1. Compressor muito suave para som natural
        const compressor = audioContext.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-30, audioContext.currentTime);
        compressor.knee.setValueAtTime(40, audioContext.currentTime);
        compressor.ratio.setValueAtTime(2, audioContext.currentTime);
        compressor.attack.setValueAtTime(0.005, audioContext.currentTime);
        compressor.release.setValueAtTime(0.3, audioContext.currentTime);
        
        // 2. Reverb para dar profundidade
        const convolver = audioContext.createConvolver();
        convolver.buffer = await createReverbBuffer(audioContext, 2, 3.5, 0.4);
        
        // 3. Dry/Wet para reverb (40% wet para mais profundidade)
        const reverbGain = audioContext.createGain();
        reverbGain.gain.value = 0.4;
        const dryGain = audioContext.createGain();
        dryGain.gain.value = 0.6;
        
        // 4. EQ de 3 bandas para melhor balanço
        const lowShelf = audioContext.createBiquadFilter();
        lowShelf.type = 'lowshelf';
        lowShelf.frequency.value = 180;
        lowShelf.gain.value = 3; // Mais corpo nos graves
        
        const midPeak = audioContext.createBiquadFilter();
        midPeak.type = 'peaking';
        midPeak.frequency.value = 800;
        midPeak.Q.value = 0.7;
        midPeak.gain.value = 0.5; // Médios bem sutis
        
        const highShelf = audioContext.createBiquadFilter();
        highShelf.type = 'highshelf';
        highShelf.frequency.value = 8000;
        highShelf.gain.value = -2; // Reduzir agudos que causam buzz
        
        // 5. Master gain (reduzido para evitar clipping)
        const masterGain = audioContext.createGain();
        masterGain.gain.value = 0.6;
        
        // Conectar cadeia: Compressor → EQ → Reverb/Dry → Master → Destination
        compressor.connect(lowShelf);
        lowShelf.connect(midPeak);
        midPeak.connect(highShelf);
        
        // Split para reverb
        highShelf.connect(dryGain);
        highShelf.connect(convolver);
        convolver.connect(reverbGain);
        
        // Mix reverb
        dryGain.connect(masterGain);
        reverbGain.connect(masterGain);
        masterGain.connect(audioContext.destination);
        
        // Salvar o nó inicial para conectar instrumentos
        audioEffectsChain = compressor;
        
        // Pré-carregar piano como instrumento padrão
        loadedInstruments[0] = await Soundfont.instrument(audioContext, 'acoustic_grand_piano', {
            destination: audioEffectsChain
        });
    }
    
    // Criar buffer de reverb artificial
    async function createReverbBuffer(audioContext, channels, duration, decay) {
        const sampleRate = audioContext.sampleRate;
        const length = sampleRate * duration;
        const buffer = audioContext.createBuffer(channels, length, sampleRate);
        
        for (let channel = 0; channel < channels; channel++) {
            const channelData = buffer.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                // Reverb decay exponencial com ruído
                channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
            }
        }
        
        return buffer;
    }

    // Tocar sample MP3 no sequenciador
    function playSampleMP3(type) {
        if (!audioSamples[type]) {
            initAudioSamples();
        }
        
        // Clonar o audio para permitir sobreposição
        const audio = audioSamples[type].cloneNode();
        audio.volume = 0.7;
        audio.play().catch(e => console.log('Erro ao tocar:', e));
    }

    // ===== FUNÇÕES DO PLAYER MIDI =====
    
    // Mapeamento de instrumentos MIDI
    const instrumentNames = {
        0: "Piano Acústico",
        24: "Violão (Nylon)",
        25: "Guitarra Elétrica",
        32: "Baixo Acústico",
        33: "Baixo Elétrico",
        40: "Violino",
        56: "Trompete",
        65: "Sax Alto",
        73: "Flauta"
    };
    
    // Arquivos MIDI das variações
    const midiFiles = {
        original: 'midi/musica_original.mid',
        alterada: 'midi/musica_alterada.mid',
        piano: 'midi/musica_original.mid' // Mesmo arquivo, mas forçará piano
    };
    
    let forcePianoMode = false; // Flag para forçar todos instrumentos como piano
async function playMIDIFile(midiPath) {
    if (!audioContext) await initMIDISynths();
    
    stopMIDI();
    
    try {
        // Buscar arquivo MIDI
        const response = await fetch(midiPath);
        const arrayBuffer = await response.arrayBuffer();
        
        // Mapa COMPLETO de instrumentos GM (0-127) para Soundfont
        const instrumentMap = {
            // Piano (0-7)
            0: 'acoustic_grand_piano', 1: 'bright_acoustic_piano', 2: 'electric_grand_piano', 
            3: 'honkytonk_piano', 4: 'electric_piano_1', 5: 'electric_piano_2', 
            6: 'harpsichord', 7: 'clavinet',
            // Chromatic Percussion (8-15)
            8: 'celesta', 9: 'glockenspiel', 10: 'music_box', 11: 'vibraphone',
            12: 'marimba', 13: 'xylophone', 14: 'tubular_bells', 15: 'dulcimer',
            // Organ (16-23)
            16: 'drawbar_organ', 17: 'percussive_organ', 18: 'rock_organ', 19: 'church_organ',
            20: 'reed_organ', 21: 'accordion', 22: 'harmonica', 23: 'tango_accordion',
            // Guitar (24-31)
            24: 'acoustic_guitar_nylon', 25: 'acoustic_guitar_steel', 26: 'electric_guitar_jazz',
            27: 'electric_guitar_clean', 28: 'electric_guitar_muted', 29: 'overdriven_guitar',
            30: 'distortion_guitar', 31: 'guitar_harmonics',
            // Bass (32-39)
            32: 'acoustic_bass', 33: 'electric_bass_finger', 34: 'electric_bass_pick',
            35: 'fretless_bass', 36: 'slap_bass_1', 37: 'slap_bass_2',
            38: 'synth_bass_1', 39: 'synth_bass_2',
            // Strings (40-47)
            40: 'violin', 41: 'viola', 42: 'cello', 43: 'contrabass',
            44: 'tremolo_strings', 45: 'pizzicato_strings', 46: 'orchestral_harp', 47: 'timpani',
            // Ensemble (48-55)
            48: 'string_ensemble_1', 49: 'string_ensemble_2', 50: 'synth_strings_1',
            51: 'synth_strings_2', 52: 'choir_aahs', 53: 'voice_oohs',
            54: 'synth_voice', 55: 'orchestra_hit',
            // Brass (56-63)
            56: 'trumpet', 57: 'trombone', 58: 'tuba', 59: 'muted_trumpet',
            60: 'french_horn', 61: 'brass_section', 62: 'synth_brass_1', 63: 'synth_brass_2',
            // Reed (64-71)
            64: 'soprano_sax', 65: 'alto_sax', 66: 'tenor_sax', 67: 'baritone_sax',
            68: 'oboe', 69: 'english_horn', 70: 'bassoon', 71: 'clarinet',
            // Pipe (72-79)
            72: 'piccolo', 73: 'flute', 74: 'recorder', 75: 'pan_flute',
            76: 'blown_bottle', 77: 'shakuhachi', 78: 'whistle', 79: 'ocarina',
            // Synth Lead (80-87)
            80: 'lead_1_square', 81: 'lead_2_sawtooth', 82: 'lead_3_calliope',
            83: 'lead_4_chiff', 84: 'lead_5_charang', 85: 'lead_6_voice',
            86: 'lead_7_fifths', 87: 'lead_8_bass__lead',
            // Synth Pad (88-95)
            88: 'pad_1_new_age', 89: 'pad_2_warm', 90: 'pad_3_polysynth',
            91: 'pad_4_choir', 92: 'pad_5_bowed', 93: 'pad_6_metallic',
            94: 'pad_7_halo', 95: 'pad_8_sweep',
            // Synth Effects (96-103)
            96: 'fx_1_rain', 97: 'fx_2_soundtrack', 98: 'fx_3_crystal',
            99: 'fx_4_atmosphere', 100: 'fx_5_brightness', 101: 'fx_6_goblins',
            102: 'fx_7_echoes', 103: 'fx_8_scifi',
            // Ethnic (104-111)
            104: 'sitar', 105: 'banjo', 106: 'shamisen', 107: 'koto',
            108: 'kalimba', 109: 'bag_pipe', 110: 'fiddle', 111: 'shanai',
            // Percussive (112-119)
            112: 'tinkle_bell', 113: 'agogo', 114: 'steel_drums', 115: 'woodblock',
            116: 'taiko_drum', 117: 'melodic_tom', 118: 'synth_drum', 119: 'reverse_cymbal',
            // Sound Effects (120-127)
            120: 'guitar_fret_noise', 121: 'breath_noise', 122: 'seashore', 123: 'bird_tweet',
            124: 'telephone_ring', 125: 'helicopter', 126: 'applause', 127: 'gunshot'
        };
        
        // Mapeamento de canal para instrumento (será preenchido pelos eventos Program Change)
        const channelInstruments = {};
        
        // Criar player
        midiPlayer = new MidiPlayer.Player(async function(event) {
            // Detectar Program Change para mapear instrumentos
            if (event.name === 'Program Change') {
                const channel = event.track || 0;
                const programNumber = forcePianoMode ? 0 : event.value; // Força piano se modo ativado
                
                if (forcePianoMode) {
                    console.log(`Canal ${channel}: Forçando Piano (modo piano ativo)`);
                } else {
                    console.log(`Canal ${channel}: Program Change para instrumento ${programNumber}`);
                }
                
                // Salvar o instrumento deste canal
                channelInstruments[channel] = programNumber;
                
                // Carregar instrumento se ainda não foi carregado
                if (!loadedInstruments[programNumber]) {
                    const instrumentName = forcePianoMode ? 'acoustic_grand_piano' : (instrumentMap[programNumber] || 'acoustic_grand_piano');
                    console.log(`Carregando instrumento ${programNumber}: ${instrumentName}`);
                    loadedInstruments[programNumber] = await Soundfont.instrument(audioContext, instrumentName, {
                        destination: audioEffectsChain
                    });
                }
            }
            
            // Tocar nota
            if (event.name === 'Note on' && event.velocity > 0) {
                const channel = event.track || 0;
                
                // Usar o instrumento do canal (ou piano se não definido)
                // Se forcePianoMode está ativo, sempre usa piano (0)
                const programNumber = forcePianoMode ? 0 : (channelInstruments[channel] !== undefined ? channelInstruments[channel] : 0);
                
                const noteNumber = event.noteNumber;
                const octave = Math.floor(noteNumber / 12) - 1;
                const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
                const noteName = noteNames[noteNumber % 12] + octave;
                
                // Usar o instrumento correto
                const instrument = loadedInstruments[programNumber] || loadedInstruments[0];
                
                if (instrument) {
                    // Normalizar velocidade com curva logarítmica mais suave
                    const normalizedVelocity = Math.pow(event.velocity / 127, 0.7) * 0.85;
                    
                    instrument.play(noteName, audioContext.currentTime, {
                        duration: 1,
                        gain: normalizedVelocity
                    });
                }
            }
        });
        
        // Carregar piano como fallback
        if (!loadedInstruments[0]) {
            loadedInstruments[0] = await Soundfont.instrument(audioContext, 'acoustic_grand_piano');
        }
        
        // Carregar e tocar
        midiPlayer.loadArrayBuffer(arrayBuffer);
        midiPlayer.play();
        
        isPlayingMIDI = true;
        
    } catch (error) {
        console.error('Erro ao carregar MIDI:', error);
        alert('Erro ao carregar arquivo MIDI. Arquivo: ' + midiPath);
        isPlayingMIDI = false;
    }
}
    function pauseMIDI() {
        if (midiPlayer && isPlayingMIDI) {
            midiPlayer.pause();
            isPlayingMIDI = false;
        }
    }

    function stopMIDI() {
        if (midiPlayer) {
            midiPlayer.stop();
            isPlayingMIDI = false;
        }
    }
    
    async function playVariation(variationType) {
        const midiPath = midiFiles[variationType];
        
        if (!midiPath) {
            console.error('Variação não encontrada:', variationType);
            return;
        }
        
        // Ativar modo piano se for a variação 'piano'
        forcePianoMode = (variationType === 'piano');
        
        await playMIDIFile(midiPath);
    }

    // Inicializar sintetizadores
    async function initSynths() {
        await initMIDISynths();
        initAudioSamples();
    }

    // Tocar sons (usa MP3 para sequenciador)
    async function playSound(type) {
        playSampleMP3(type);
        animateCanvas('#667eea', 'wave');
    }

    // ===== ANIMAÇÕES CANVAS =====
    function animateCanvas(color, type) {
        const canvas = document.getElementById('animationCanvas');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 4;
        ctx.shadowBlur = 20;
        ctx.shadowColor = color;
        
        switch(type) {
            case 'circle':
                for (let i = 0; i < 6; i++) {
                    ctx.beginPath();
                    ctx.arc(centerX, centerY, 30 + i * 40, 0, Math.PI * 2);
                    ctx.stroke();
                }
                break;
            case 'burst':
                for (let i = 0; i < 16; i++) {
                    const angle = (Math.PI * 2 / 16) * i;
                    ctx.beginPath();
                    ctx.moveTo(centerX, centerY);
                    ctx.lineTo(centerX + Math.cos(angle) * 120, centerY + Math.sin(angle) * 120);
                    ctx.stroke();
                }
                break;
            case 'spark':
                for (let i = 0; i < 30; i++) {
                    const x = centerX + (Math.random() - 0.5) * 250;
                    const y = centerY + (Math.random() - 0.5) * 250;
                    ctx.fillRect(x, y, 5, 5);
                }
                break;
            case 'wave':
                ctx.beginPath();
                for (let x = 0; x < canvas.width; x += 3) {
                    const y = centerY + Math.sin(x * 0.015) * 80;
                    ctx.lineTo(x, y);
                }
                ctx.stroke();
                break;
            case 'glow':
                ctx.globalAlpha = 0.2;
                for (let i = 0; i < 12; i++) {
                    ctx.beginPath();
                    ctx.arc(centerX, centerY, 40 + i * 25, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.globalAlpha = 1;
                break;
            case 'lightning':
                ctx.beginPath();
                ctx.moveTo(centerX, 50);
                let x = centerX;
                let y = 50;
                while (y < canvas.height - 50) {
                    x += (Math.random() - 0.5) * 60;
                    y += 40;
                    ctx.lineTo(x, y);
                }
                ctx.stroke();
                break;
        }
        
        ctx.shadowBlur = 0;
    }

    // ===== ANIMAÇÃO DOS INSTRUMENTOS DO SEQUENCIADOR =====
    const animCanvas = document.getElementById('instrumentAnimation');
    const animCtx = animCanvas ? animCanvas.getContext('2d') : null;
    
    // Objetos dos instrumentos com física avançada
    const instruments = {
        kick: { 
            x: 200, y: 200, 
            scale: 1, 
            rotation: 0, 
            impact: 0, 
            beaterAngle: -30,
            beaterVelocity: 0,
            skinDeformation: 0,
            shockwaves: []
        },
        snare: { 
            x: 500, y: 200, 
            stickY: -80,
            stickVelocity: 0,
            stickRotation: -25,
            stickIsHitting: false,
            vibration: 0,
            wireVibrations: [],
            skinWaves: 0,
            rimImpact: 0
        },
        hihat: { 
            x: 800, y: 200, 
            topPlateY: -20,
            bottomPlateY: 20,
            openAmount: 0,
            topPlateRotation: 0,
            splashParticles: [],
            pedalAngle: 0
        },
        bass: { 
            x: 1100, y: 200, 
            speakerPulse: 0,
            coneMovement: 0,
            coneRotation: 0,
            dustParticles: [],
            waveRings: [],
            cabinetVibration: 0
        }
    };
    
    function animateInstrument(instrument) {
        if (!animCtx) return;
        
        if (instrument === 'kick') {
            // KICK: Impacto com física realista
            instruments.kick.impact = 1;
            instruments.kick.scale = 1.3;
            instruments.kick.beaterVelocity = 25;
            instruments.kick.skinDeformation = 1;
            instruments.kick.shockwaves.push({ radius: 0, alpha: 1, thickness: 6 });
            instruments.kick.shockwaves.push({ radius: 15, alpha: 0.7, thickness: 4 });
            instruments.kick.shockwaves.push({ radius: 30, alpha: 0.4, thickness: 2 });
        } else if (instrument === 'snare') {
            // SNARE: Baqueta com física + vibração das esteiras
            instruments.snare.stickIsHitting = true;
            instruments.snare.stickVelocity = 35;
            instruments.snare.vibration = 1;
            instruments.snare.skinWaves = 1;
            instruments.snare.rimImpact = 0.8;
            // Criar vibrações individuais nas esteiras
            for (let i = 0; i < 12; i++) {
                instruments.snare.wireVibrations.push({
                    index: i,
                    amplitude: Math.random() * 8 + 5,
                    phase: Math.random() * Math.PI * 2,
                    decay: 0.92
                });
            }
        } else if (instrument === 'hihat') {
            // HI-HAT: Abertura rápida com splash
            instruments.hihat.openAmount = 50;
            instruments.hihat.topPlateRotation = (Math.random() - 0.5) * 0.3;
            instruments.hihat.pedalAngle = 25;
            // Partículas de "brilho" do metal
            for (let i = 0; i < 16; i++) {
                const angle = (Math.PI * 2 / 16) * i + Math.random() * 0.3;
                instruments.hihat.splashParticles.push({
                    x: 0,
                    y: -30,
                    vx: Math.cos(angle) * (2 + Math.random() * 2),
                    vy: Math.sin(angle) * (2 + Math.random() * 2) - 3,
                    size: 2 + Math.random() * 3,
                    alpha: 1,
                    rotation: Math.random() * Math.PI * 2
                });
            }
        } else if (instrument === 'bass') {
            // BASS: Pulsação do cone com partículas de ar
            instruments.bass.speakerPulse = 1;
            instruments.bass.coneMovement = 25;
            instruments.bass.cabinetVibration = 1;
            instruments.bass.waveRings.push({ radius: 50, alpha: 1, thickness: 5 });
            instruments.bass.waveRings.push({ radius: 65, alpha: 0.6, thickness: 3 });
            // Partículas de "poeira" sendo empurradas
            for (let i = 0; i < 20; i++) {
                const angle = Math.random() * Math.PI * 2;
                const speed = 3 + Math.random() * 4;
                instruments.bass.dustParticles.push({
                    x: Math.cos(angle) * 30,
                    y: Math.sin(angle) * 30,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    size: 1 + Math.random() * 2,
                    alpha: 0.7,
                    life: 1
                });
            }
        }
    }
    
    // Loop de animação contínuo
    function updateInstrumentAnimation() {
        if (!animCtx) return;
        
        // Fundo com grid
        const bgGradient = animCtx.createLinearGradient(0, 0, animCanvas.width, animCanvas.height);
        bgGradient.addColorStop(0, '#1a1a2e');
        bgGradient.addColorStop(0.5, '#16213e');
        bgGradient.addColorStop(1, '#0f3460');
        animCtx.fillStyle = bgGradient;
        animCtx.fillRect(0, 0, animCanvas.width, animCanvas.height);
        
        // Grid sutil
        animCtx.strokeStyle = 'rgba(102, 126, 234, 0.08)';
        animCtx.lineWidth = 1;
        for (let i = 0; i < animCanvas.width; i += 60) {
            animCtx.beginPath();
            animCtx.moveTo(i, 0);
            animCtx.lineTo(i, animCanvas.height);
            animCtx.stroke();
        }
        
        // ===== DESENHAR KICK DRUM (AVANÇADO) =====
        const kick = instruments.kick;
        animCtx.save();
        animCtx.translate(kick.x, kick.y);
        
        // Ondas de choque múltiplas com decay
        kick.shockwaves.forEach((wave, idx) => {
            wave.radius += 5 + idx * 2;
            wave.alpha *= 0.92;
            wave.thickness *= 0.96;
            
            if (wave.alpha > 0.01) {
                animCtx.strokeStyle = `rgba(239, 68, 68, ${wave.alpha})`;
                animCtx.lineWidth = wave.thickness;
                animCtx.shadowBlur = 25;
                animCtx.shadowColor = '#ef4444';
                animCtx.beginPath();
                animCtx.arc(0, 0, wave.radius, 0, Math.PI * 2);
                animCtx.stroke();
            }
        });
        kick.shockwaves = kick.shockwaves.filter(w => w.alpha > 0.01);
        
        animCtx.save();
        animCtx.scale(kick.scale, kick.scale);
        
        // Sombra do corpo
        animCtx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        animCtx.fillRect(-52, -28, 104, 58);
        
        // Corpo do bumbo com gradiente 3D
        const kickBodyGrad = animCtx.createLinearGradient(-50, -30, -50, 30);
        kickBodyGrad.addColorStop(0, '#ff5555');
        kickBodyGrad.addColorStop(0.5, '#ef4444');
        kickBodyGrad.addColorStop(1, '#b91c1c');
        animCtx.fillStyle = kickBodyGrad;
        animCtx.shadowBlur = 20;
        animCtx.shadowColor = '#ef4444';
        animCtx.fillRect(-50, -30, 100, 60);
        
        // Detalhes metálicos (aros)
        animCtx.strokeStyle = '#888';
        animCtx.lineWidth = 3;
        animCtx.shadowBlur = 0;
        animCtx.beginPath();
        animCtx.ellipse(0, -30, 50, 8, 0, 0, Math.PI);
        animCtx.stroke();
        animCtx.beginPath();
        animCtx.ellipse(0, 30, 50, 8, 0, Math.PI, Math.PI * 2);
        animCtx.stroke();
        
        // Pele frontal com deformação
        const skinDeform = kick.skinDeformation * 15;
        animCtx.fillStyle = '#fef3c7';
        animCtx.shadowBlur = 10;
        animCtx.shadowColor = '#fbbf24';
        animCtx.beginPath();
        animCtx.ellipse(0, 0, 48 - skinDeform * 0.3, 28 + skinDeform, 0, 0, Math.PI * 2);
        animCtx.fill();
        
        // Marca/logo na pele
        animCtx.fillStyle = 'rgba(0, 0, 0, 0.2)';
        animCtx.font = 'bold 12px Arial';
        animCtx.textAlign = 'center';
        animCtx.shadowBlur = 0;
        animCtx.fillText('KICK', 0, 5);
        
        animCtx.restore();
        
        // Pedal e batedor com animação física
        const beaterDist = 70 + kick.beaterAngle * 1.5;
        const beaterX = -Math.cos((kick.beaterAngle * Math.PI) / 180) * beaterDist;
        const beaterY = Math.sin((kick.beaterAngle * Math.PI) / 180) * beaterDist;
        
        // Haste do pedal
        animCtx.strokeStyle = '#666';
        animCtx.lineWidth = 4;
        animCtx.shadowBlur = 5;
        animCtx.shadowColor = '#000';
        animCtx.beginPath();
        animCtx.moveTo(-80, 50);
        animCtx.lineTo(beaterX, beaterY);
        animCtx.stroke();
        
        // Articulação
        animCtx.fillStyle = '#444';
        animCtx.beginPath();
        animCtx.arc(-80, 50, 6, 0, Math.PI * 2);
        animCtx.fill();
        
        // Cabeça do batedor com volume
        const beaterGrad = animCtx.createRadialGradient(beaterX - 2, beaterY - 2, 2, beaterX, beaterY, 12);
        beaterGrad.addColorStop(0, '#888');
        beaterGrad.addColorStop(1, '#333');
        animCtx.fillStyle = beaterGrad;
        animCtx.shadowBlur = 10;
        animCtx.shadowColor = '#000';
        animCtx.beginPath();
        animCtx.arc(beaterX, beaterY, 12, 0, Math.PI * 2);
        animCtx.fill();
        
        animCtx.shadowBlur = 0;
        animCtx.restore();
        
        // Label
        animCtx.font = 'bold 16px Arial';
        animCtx.textAlign = 'center';
        animCtx.fillStyle = '#ef4444';
        animCtx.fillText('KICK DRUM 🥁', kick.x, 320);
        
        // Física avançada
        kick.beaterAngle += kick.beaterVelocity;
        kick.beaterVelocity *= 0.88;
        kick.beaterAngle += (-30 - kick.beaterAngle) * 0.15;
        kick.impact *= 0.87;
        kick.scale = 1 + kick.impact * 0.25;
        kick.skinDeformation *= 0.85;
        
    // ===== DESENHAR SNARE (AVANÇADO) =====
        const snare = instruments.snare;
        animCtx.save();
        animCtx.translate(snare.x, snare.y);
        
        // Vibração do corpo inteiro
        const bodyShake = snare.vibration > 0 ? 
            { x: (Math.random() - 0.5) * snare.vibration * 4, 
              y: (Math.random() - 0.5) * snare.vibration * 2 } : 
            { x: 0, y: 0 };
        animCtx.translate(bodyShake.x, bodyShake.y);
        
        // Sombra
        animCtx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        animCtx.fillRect(-57, -13, 114, 32);
        
        // Corpo da caixa com gradiente metálico
        const snareBodyGrad = animCtx.createLinearGradient(-55, -15, -55, 15);
        snareBodyGrad.addColorStop(0, '#34d399');
        snareBodyGrad.addColorStop(0.5, '#10b981');
        snareBodyGrad.addColorStop(1, '#059669');
        animCtx.fillStyle = snareBodyGrad;
        animCtx.shadowBlur = 20;
        animCtx.shadowColor = '#10b981';
        animCtx.fillRect(-55, -15, 110, 30);
        
        // Detalhes metálicos (lugs)
        animCtx.fillStyle = '#888';
        animCtx.shadowBlur = 0;
        [-45, -15, 15, 45].forEach(x => {
            animCtx.fillRect(x - 3, -18, 6, 6);
            animCtx.fillRect(x - 3, 12, 6, 6);
        });
        
        // Aro superior com reflexo
        animCtx.strokeStyle = '#aaa';
        animCtx.lineWidth = 3;
        animCtx.beginPath();
        animCtx.ellipse(0, -15, 56, 11, 0, 0, Math.PI * 2);
        animCtx.stroke();
        
        // Pele superior com ondulação
        const waveOffset = snare.skinWaves * Math.sin(Date.now() * 0.02) * 3;
        animCtx.fillStyle = '#f0fdf4';
        animCtx.shadowBlur = 8;
        animCtx.shadowColor = '#10b981';
        animCtx.beginPath();
        animCtx.ellipse(0, -15 + waveOffset * 0.3, 52, 9, 0, 0, Math.PI * 2);
        animCtx.fill();
        
        // Círculo central da pele
        animCtx.fillStyle = 'rgba(0, 0, 0, 0.1)';
        animCtx.shadowBlur = 0;
        animCtx.beginPath();
        animCtx.arc(0, -15, 15, 0, Math.PI * 2);
        animCtx.fill();
        
        // Aro inferior
        animCtx.strokeStyle = '#999';
        animCtx.lineWidth = 2;
        animCtx.beginPath();
        animCtx.ellipse(0, 15, 56, 11, 0, Math.PI, Math.PI * 2);
        animCtx.stroke();
        
        // Esteira (fios metálicos) com vibração individual
        snare.wireVibrations.forEach((wire, i) => {
            wire.amplitude *= wire.decay;
            wire.phase += 0.5;
            
            const xPos = -44 + i * 8;
            const vibOffset = Math.sin(wire.phase) * wire.amplitude;
            
            const wireGrad = animCtx.createLinearGradient(xPos, 13, xPos, 17);
            wireGrad.addColorStop(0, '#ddd');
            wireGrad.addColorStop(0.5, '#fff');
            wireGrad.addColorStop(1, '#aaa');
            animCtx.strokeStyle = wireGrad;
            animCtx.lineWidth = 1.5;
            animCtx.beginPath();
            animCtx.moveTo(xPos + vibOffset, 13);
            animCtx.lineTo(xPos + vibOffset * 0.5, 17);
            animCtx.stroke();
        });
        snare.wireVibrations = snare.wireVibrations.filter(w => w.amplitude > 0.1);
        
        // Reflexo de luz no aro
        if (snare.rimImpact > 0) {
            animCtx.strokeStyle = `rgba(255, 255, 255, ${snare.rimImpact})`;
            animCtx.lineWidth = 2;
            animCtx.shadowBlur = 15;
            animCtx.shadowColor = '#fff';
            animCtx.beginPath();
            animCtx.arc(30, -15, 20, Math.PI * 0.7, Math.PI * 1.3);
            animCtx.stroke();
        }
        
        // Baqueta lateral com física realista
        animCtx.save();
        
        // Física da baqueta
        if (snare.stickIsHitting) {
            snare.stickY += snare.stickVelocity;
            snare.stickVelocity += 2.8; // Gravidade
            
            // Limite: bater na pele da caixa
            if (snare.stickY > -15) {
                snare.stickY = -15;
                snare.stickVelocity *= -0.35; // Bounce
                
                // Para de bater após o bounce
                if (Math.abs(snare.stickVelocity) < 2) {
                    snare.stickIsHitting = false;
                    snare.stickVelocity = 0;
                }
            }
        } else {
            // Retorna para posição de repouso (acima e à direita)
            snare.stickY += (-65 - snare.stickY) * 0.15;
        }
        
        // Posicionar baqueta lateralmente (à direita da caixa)
        animCtx.translate(35, snare.stickY);
        
        // Rotação fixa para bater lateral (aproximadamente 30 graus)
        animCtx.rotate((30 * Math.PI) / 180);
        
        // Haste da baqueta com gradiente
        const stickGrad = animCtx.createLinearGradient(0, -50, 0, 0);
        stickGrad.addColorStop(0, '#f4a460');
        stickGrad.addColorStop(0.5, '#d4a574');
        stickGrad.addColorStop(1, '#b8956a');
        animCtx.strokeStyle = stickGrad;
        animCtx.lineWidth = 5;
        animCtx.lineCap = 'round';
        animCtx.shadowBlur = 8;
        animCtx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        animCtx.beginPath();
        animCtx.moveTo(0, -50);
        animCtx.lineTo(0, 0);
        animCtx.stroke();
        
        // Ponta da baqueta (nylon)
        animCtx.fillStyle = '#fff';
        animCtx.shadowBlur = 5;
        animCtx.shadowColor = '#fff';
        animCtx.beginPath();
        animCtx.ellipse(0, 0, 4, 7, 0, 0, Math.PI * 2);
        animCtx.fill();
        
        animCtx.restore();
        animCtx.shadowBlur = 0;
        animCtx.restore();
        
        animCtx.font = 'bold 16px Arial';
        animCtx.fillStyle = '#10b981';
        animCtx.textAlign = 'center';
        animCtx.fillText('SNARE DRUM 🎯', snare.x, 320);
        
        // Física
        snare.vibration *= 0.92;
        snare.skinWaves *= 0.88;
        snare.rimImpact *= 0.90;
        
        // ===== DESENHAR HI-HAT (AVANÇADO) =====
        const hihat = instruments.hihat;
        animCtx.save();
        animCtx.translate(hihat.x, hihat.y);
        
        // Partículas de brilho metálico
        hihat.splashParticles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.3; // Gravidade
            p.alpha *= 0.94;
            p.size *= 0.97;
            p.rotation += 0.15;
            
            if (p.alpha > 0.05) {
                animCtx.save();
                animCtx.translate(p.x, p.y);
                animCtx.rotate(p.rotation);
                animCtx.fillStyle = `rgba(251, 191, 36, ${p.alpha})`;
                animCtx.shadowBlur = 8;
                animCtx.shadowColor = '#fbbf24';
                animCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
                animCtx.restore();
            }
        });
        hihat.splashParticles = hihat.splashParticles.filter(p => p.alpha > 0.05);
        
        // Pedestal com detalhes
        const pedestalGrad = animCtx.createLinearGradient(-2, 30, 2, 60);
        pedestalGrad.addColorStop(0, '#888');
        pedestalGrad.addColorStop(0.5, '#555');
        pedestalGrad.addColorStop(1, '#333');
        animCtx.fillStyle = pedestalGrad;
        animCtx.fillRect(-4, 30, 8, 35);
        
        // Base tripé
        for (let i = 0; i < 3; i++) {
            const angle = (i * Math.PI * 2 / 3) + hihat.pedalAngle * 0.01;
            animCtx.save();
            animCtx.rotate(angle);
            animCtx.fillStyle = '#444';
            animCtx.fillRect(-3, 60, 6, 25);
            animCtx.restore();
        }
        
        // Clutch (mecanismo central)
        animCtx.fillStyle = '#777';
        animCtx.fillRect(-6, 20, 12, 15);
        
        // Prato inferior com textura e reflexo
        animCtx.save();
        const bottomPlateGrad = animCtx.createRadialGradient(0, 20, 0, 0, 20, 55);
        bottomPlateGrad.addColorStop(0, '#fbbf24');
        bottomPlateGrad.addColorStop(0.3, '#f59e0b');
        bottomPlateGrad.addColorStop(0.7, '#d97706');
        bottomPlateGrad.addColorStop(1, '#b45309');
        animCtx.fillStyle = bottomPlateGrad;
        animCtx.shadowBlur = 20;
        animCtx.shadowColor = '#f59e0b';
        animCtx.beginPath();
        animCtx.ellipse(0, 20, 52, 9, 0, 0, Math.PI * 2);
        animCtx.fill();
        
        // Grooves (ranhuras) no prato inferior
        animCtx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
        animCtx.lineWidth = 1;
        for (let r = 15; r < 50; r += 8) {
            animCtx.beginPath();
            animCtx.ellipse(0, 20, r, r * 0.18, 0, 0, Math.PI * 2);
            animCtx.stroke();
        }
        
        // Dome (cúpula central) inferior
        const domeGrad = animCtx.createRadialGradient(-2, 18, 2, 0, 20, 12);
        domeGrad.addColorStop(0, '#fde68a');
        domeGrad.addColorStop(1, '#f59e0b');
        animCtx.fillStyle = domeGrad;
        animCtx.beginPath();
        animCtx.arc(0, 20, 10, 0, Math.PI * 2);
        animCtx.fill();
        animCtx.restore();
        
        // Prato superior (animado) com rotação
        animCtx.save();
        const topY = -hihat.openAmount;
        animCtx.translate(0, topY);
        animCtx.rotate(hihat.topPlateRotation);
        
        const topPlateGrad = animCtx.createRadialGradient(0, 0, 0, 0, 0, 55);
        topPlateGrad.addColorStop(0, '#fcd34d');
        topPlateGrad.addColorStop(0.3, '#fbbf24');
        topPlateGrad.addColorStop(0.7, '#f59e0b');
        topPlateGrad.addColorStop(1, '#d97706');
        animCtx.fillStyle = topPlateGrad;
        animCtx.shadowBlur = 25;
        animCtx.shadowColor = '#fbbf24';
        animCtx.beginPath();
        animCtx.ellipse(0, 0, 52, 9, 0, 0, Math.PI * 2);
        animCtx.fill();
        
        // Grooves no prato superior
        animCtx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
        animCtx.lineWidth = 1;
        for (let r = 15; r < 50; r += 8) {
            animCtx.beginPath();
            animCtx.ellipse(0, 0, r, r * 0.18, 0, 0, Math.PI * 2);
            animCtx.stroke();
        }
        
        // Dome superior
        const topDomeGrad = animCtx.createRadialGradient(-2, -2, 2, 0, 0, 12);
        topDomeGrad.addColorStop(0, '#fef3c7');
        topDomeGrad.addColorStop(1, '#fbbf24');
        animCtx.fillStyle = topDomeGrad;
        animCtx.shadowBlur = 10;
        animCtx.shadowColor = '#fbbf24';
        animCtx.beginPath();
        animCtx.arc(0, 0, 10, 0, Math.PI * 2);
        animCtx.fill();
        
        animCtx.restore();
        
        // Linhas de movimento (motion blur)
        if (hihat.openAmount > 8) {
            for (let i = 1; i <= 4; i++) {
                animCtx.strokeStyle = `rgba(251, 191, 36, ${(0.4 / i) * (hihat.openAmount / 50)})`;
                animCtx.lineWidth = 2;
                animCtx.shadowBlur = 15;
                animCtx.shadowColor = '#fbbf24';
                animCtx.beginPath();
                animCtx.ellipse(0, topY - i * 6, 52 + i * 4, 9, 0, 0, Math.PI * 2);
                animCtx.stroke();
            }
        }
        
        // Pedal (visual simplificado)
        animCtx.save();
        animCtx.translate(-35, 70);
        animCtx.rotate((-hihat.pedalAngle * Math.PI) / 180);
        animCtx.fillStyle = '#555';
        animCtx.fillRect(0, 0, 40, 8);
        animCtx.fillStyle = '#333';
        animCtx.fillRect(30, -3, 10, 14);
        animCtx.restore();
        
        animCtx.shadowBlur = 0;
        animCtx.restore();
        
        animCtx.font = 'bold 16px Arial';
        animCtx.fillStyle = '#f59e0b';
        animCtx.textAlign = 'center';
        animCtx.fillText('HI-HAT 🔔', hihat.x, 320);
        
        // Física
        hihat.openAmount *= 0.88;
        hihat.topPlateRotation *= 0.93;
        hihat.pedalAngle *= 0.90;
        
        // ===== DESENHAR BASS SPEAKER (AVANÇADO) =====
        const bass = instruments.bass;
        animCtx.save();
        animCtx.translate(bass.x, bass.y);
        
        // Vibração do gabinete
        const cabinetShake = bass.cabinetVibration > 0 ?
            { x: (Math.random() - 0.5) * bass.cabinetVibration * 5,
              y: (Math.random() - 0.5) * bass.cabinetVibration * 3 } :
            { x: 0, y: 0 };
        animCtx.translate(cabinetShake.x, cabinetShake.y);
        
        // Ondas sonoras expandindo
        bass.waveRings.forEach(ring => {
            ring.radius += 8;
            ring.alpha *= 0.90;
            ring.thickness *= 0.94;
            
            if (ring.alpha > 0.02) {
                animCtx.strokeStyle = `rgba(59, 130, 246, ${ring.alpha})`;
                animCtx.lineWidth = ring.thickness;
                animCtx.shadowBlur = 30;
                animCtx.shadowColor = '#3b82f6';
                animCtx.beginPath();
                animCtx.arc(0, 0, ring.radius, 0, Math.PI * 2);
                animCtx.stroke();
                
                // Onda secundária (harmônica)
                animCtx.strokeStyle = `rgba(96, 165, 250, ${ring.alpha * 0.5})`;
                animCtx.lineWidth = ring.thickness * 0.6;
                animCtx.beginPath();
                animCtx.arc(0, 0, ring.radius + 10, 0, Math.PI * 2);
                animCtx.stroke();
            }
        });
        bass.waveRings = bass.waveRings.filter(r => r.alpha > 0.02);
        
        // Partículas de ar/poeira
        bass.dustParticles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            p.vx *= 0.96;
            p.vy *= 0.96;
            p.alpha *= 0.93;
            p.life *= 0.94;
            
            if (p.alpha > 0.05) {
                animCtx.fillStyle = `rgba(147, 197, 253, ${p.alpha})`;
                animCtx.shadowBlur = 5;
                animCtx.shadowColor = '#60a5fa';
                animCtx.beginPath();
                animCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                animCtx.fill();
            }
        });
        bass.dustParticles = bass.dustParticles.filter(p => p.life > 0.1);
        
        // Sombra do gabinete
        animCtx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        animCtx.fillRect(-58, -58, 116, 116);
        
        // Gabinete com gradiente texturizado
        const cabinetGrad = animCtx.createLinearGradient(-60, -60, -60, 60);
        cabinetGrad.addColorStop(0, '#1e293b');
        cabinetGrad.addColorStop(0.5, '#0f172a');
        cabinetGrad.addColorStop(1, '#020617');
        animCtx.fillStyle = cabinetGrad;
        animCtx.fillRect(-60, -60, 120, 120);
        
        // Textura de madeira (linhas)
        animCtx.strokeStyle = 'rgba(51, 65, 85, 0.3)';
        animCtx.lineWidth = 1;
        for (let i = -55; i < 55; i += 8) {
            animCtx.beginPath();
            animCtx.moveTo(i, -60);
            animCtx.lineTo(i, 60);
            animCtx.stroke();
        }
        
        // Borda do gabinete
        animCtx.strokeStyle = '#475569';
        animCtx.lineWidth = 4;
        animCtx.strokeRect(-60, -60, 120, 120);
        
        // Parafusos nos cantos
        animCtx.fillStyle = '#64748b';
        [[-53, -53], [53, -53], [-53, 53], [53, 53]].forEach(([x, y]) => {
            animCtx.beginPath();
            animCtx.arc(x, y, 3, 0, Math.PI * 2);
            animCtx.fill();
            // Fenda do parafuso
            animCtx.strokeStyle = '#334155';
            animCtx.lineWidth = 1;
            animCtx.beginPath();
            animCtx.moveTo(x - 2, y);
            animCtx.lineTo(x + 2, y);
            animCtx.stroke();
        });
        
        // Moldura do alto-falante
        animCtx.fillStyle = '#1e3a8a';
        animCtx.shadowBlur = 0;
        animCtx.beginPath();
        animCtx.arc(0, 0, 58, 0, Math.PI * 2);
        animCtx.fill();
        
        // Parafusos da moldura
        animCtx.fillStyle = '#334155';
        for (let i = 0; i < 8; i++) {
            const angle = (i * Math.PI * 2 / 8);
            const x = Math.cos(angle) * 52;
            const y = Math.sin(angle) * 52;
            animCtx.beginPath();
            animCtx.arc(x, y, 3, 0, Math.PI * 2);
            animCtx.fill();
        }
        
        // Suspensão externa (rubber surround)
        animCtx.save();
        animCtx.rotate(bass.coneRotation);
        const surroundGrad = animCtx.createRadialGradient(0, 0, 40, 0, 0, 50);
        surroundGrad.addColorStop(0, '#1e40af');
        surroundGrad.addColorStop(0.5, '#1e3a8a');
        surroundGrad.addColorStop(1, '#1e293b');
        animCtx.fillStyle = surroundGrad;
        animCtx.shadowBlur = 15;
        animCtx.shadowColor = '#3b82f6';
        animCtx.beginPath();
        animCtx.arc(0, 0, 50, 0, Math.PI * 2);
        animCtx.fill();
        
        // Ondulações na suspensão
        animCtx.strokeStyle = 'rgba(30, 58, 138, 0.5)';
        animCtx.lineWidth = 2;
        for (let r = 42; r <= 48; r += 3) {
            animCtx.beginPath();
            animCtx.arc(0, 0, r, 0, Math.PI * 2);
            animCtx.stroke();
        }
        animCtx.restore();
        
        // Cone do alto-falante (movimento para dentro/fora)
        const coneOffset = bass.coneMovement;
        const coneScale = 1 - (coneOffset * 0.015);
        animCtx.save();
        animCtx.scale(coneScale, coneScale);
        animCtx.rotate(bass.coneRotation * 1.5);
        
        const coneGrad = animCtx.createRadialGradient(-5, -5, 5, 0, 0, 45);
        coneGrad.addColorStop(0, '#60a5fa');
        coneGrad.addColorStop(0.4, '#3b82f6');
        coneGrad.addColorStop(0.8, '#2563eb');
        coneGrad.addColorStop(1, '#1d4ed8');
        animCtx.fillStyle = coneGrad;
        animCtx.shadowBlur = 25;
        animCtx.shadowColor = '#3b82f6';
        animCtx.beginPath();
        animCtx.arc(0, 0, 42, 0, Math.PI * 2);
        animCtx.fill();
        
        // Textura do cone (linhas radiais)
        animCtx.strokeStyle = 'rgba(30, 64, 175, 0.3)';
        animCtx.lineWidth = 1;
        for (let i = 0; i < 12; i++) {
            const angle = (i * Math.PI * 2 / 12);
            animCtx.beginPath();
            animCtx.moveTo(Math.cos(angle) * 12, Math.sin(angle) * 12);
            animCtx.lineTo(Math.cos(angle) * 40, Math.sin(angle) * 40);
            animCtx.stroke();
        }
        
        // Dust cap (cúpula central)
        const dustCapGrad = animCtx.createRadialGradient(-3, -3, 2, 0, 0, 15);
        dustCapGrad.addColorStop(0, '#93c5fd');
        dustCapGrad.addColorStop(0.5, '#60a5fa');
        dustCapGrad.addColorStop(1, '#3b82f6');
        animCtx.fillStyle = dustCapGrad;
        animCtx.shadowBlur = 15;
        animCtx.shadowColor = '#60a5fa';
        animCtx.beginPath();
        animCtx.arc(0, 0, 12, 0, Math.PI * 2);
        animCtx.fill();
        
        // Reflexo na dust cap
        animCtx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        animCtx.shadowBlur = 0;
        animCtx.beginPath();
        animCtx.arc(-3, -3, 4, 0, Math.PI * 2);
        animCtx.fill();
        
        animCtx.restore();
        animCtx.shadowBlur = 0;
        animCtx.restore();
        
        animCtx.font = 'bold 16px Arial';
        animCtx.fillStyle = '#3b82f6';
        animCtx.textAlign = 'center';
        animCtx.fillText('BASS SPEAKER 🔊', bass.x, 320);
        
        // Física
        bass.speakerPulse *= 0.89;
        bass.coneMovement *= 0.86;
        bass.coneRotation += 0.03 * bass.speakerPulse;
        bass.cabinetVibration *= 0.88;
        
        requestAnimationFrame(updateInstrumentAnimation);
    }
    
    // Iniciar loop de animação
    if (animCtx) {
        updateInstrumentAnimation();
    }

    // ===== NAVEGAÇÃO =====
    function showSection(sectionId) {
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        
        document.getElementById(sectionId).classList.add('active');
        event.target.classList.add('active');
    }

    // ===== SEQUENCIADOR =====
    document.querySelectorAll('.seq-step').forEach(step => {
        step.addEventListener('click', function() {
            this.classList.toggle('active');
        });
    });

    function updateTempo(value) {
        tempo = parseInt(value);
        document.getElementById('tempoDisplay').textContent = tempo + ' BPM';
        // Mudança instantânea - próximo step já usa o novo tempo
    }

    function scheduleStep(time) {
        // Agendar atualização visual
        const delay = (time - audioContext.currentTime) * 1000;
        
        setTimeout(() => {
            document.querySelectorAll('.seq-step.playing').forEach(s => s.classList.remove('playing'));
            
            document.querySelectorAll(`[data-step="${currentStep}"]`).forEach(step => {
                step.classList.add('playing');
                if (step.classList.contains('active')) {
                    const sound = step.dataset.sound;
                    playSampleMP3(sound);
                    animateInstrument(sound); // Adicionar animação visual
                }
            });
        }, delay);
    }

    function startSequenceLoop() {
        if (!isPlaying) return;
        
        const stepTime = (60 / tempo) / 4; // Duração de cada step em segundos
        
        // Agendar próximo step
        while (nextStepTime < audioContext.currentTime + scheduleAheadTime) {
            scheduleStep(nextStepTime);
            nextStepTime += stepTime;
            currentStep = (currentStep + 1) % 16;
        }
        
        // Verificar novamente em 25ms
        sequenceInterval = setTimeout(() => startSequenceLoop(), 25);
    }

    async function playSequence() {
        if (isPlaying) return;
        
        if (!audioSamples.kick) {
            initAudioSamples();
        }
        
        if (!audioContext) {
            await initMIDISynths();
        }
        
        isPlaying = true;
        currentStep = 0;
        nextStepTime = audioContext.currentTime;
        
        startSequenceLoop();
    }

    function stopSequence() {
        isPlaying = false;
        clearTimeout(sequenceInterval);
        document.querySelectorAll('.seq-step.playing').forEach(s => s.classList.remove('playing'));
    }

    function clearSequence() {
        stopSequence();
        document.querySelectorAll('.seq-step').forEach(s => s.classList.remove('active'));
    }

    function loadPattern() {
        clearSequence();
        const pattern = {
            kick: [0, 4, 8, 12],
            snare: [4, 12],
            hihat: [0, 2, 4, 6, 8, 10, 12, 14],
            bass: [0, 3, 7, 10]
        };
        
        for (let sound in pattern) {
            pattern[sound].forEach(step => {
                document.querySelector(`[data-sound="${sound}"][data-step="${step}"]`).classList.add('active');
            });
        }
    }

    // ===== QUIZ =====
    const quizDatabase = [
        {
            question: "O que é síntese de áudio?",
            options: [
                "Gravação de sons naturais",
                "Criação artificial de sons usando componentes eletrônicos ou digitais",
                "Edição de áudio gravado",
                "Mixagem de múltiplas faixas"
            ],
            correct: 1
        },
        {
            question: "Qual forma de onda produz o som mais puro e suave, sem harmônicos?",
            options: ["Square (Quadrada)", "Sawtooth (Dente de Serra)", "Sine (Senoidal)", "Triangle (Triangular)"],
            correct: 2
        },
        {
            question: "O que significa ADSR em um sintetizador?",
            options: [
                "Audio Digital Sound Recording",
                "Attack, Decay, Sustain, Release",
                "Analog Digital Synthesis Rate",
                "Amplitude Distribution Sound Range"
            ],
            correct: 1
        },
        {
            question: "Qual tipo de síntese começa com ondas ricas em harmônicos e usa filtros para remover frequências?",
            options: ["Síntese Aditiva", "Síntese FM", "Síntese Subtrativa", "Síntese por Tabela"],
            correct: 2
        },
        {
            question: "Qual instrumento sintético é conhecido como 'Bumbo'?",
            options: ["Snare", "Hi-Hat", "Kick", "Bass"],
            correct: 2
        },
        {
            question: "A forma de onda Sawtooth é conhecida por ter um som:",
            options: ["Suave e puro", "Brilhante e rico em todos os harmônicos", "Oco e robótico", "Silencioso"],
            correct: 1
        },
        {
            question: "O que é um oscilador em um sintetizador?",
            options: [
                "Um efeito de reverberação",
                "Um componente que gera formas de onda",
                "Um tipo de filtro",
                "Um amplificador"
            ],
            correct: 1
        },
        {
            question: "Qual parâmetro do ADSR controla quanto tempo o som leva para desaparecer completamente após soltar a tecla?",
            options: ["Attack", "Decay", "Sustain", "Release"],
            correct: 3
        },
        {
            question: "A síntese FM (Frequency Modulation) funciona:",
            options: [
                "Adicionando múltiplas ondas",
                "Removendo frequências",
                "Modulando a frequência de uma onda com outra",
                "Gravando sons reais"
            ],
            correct: 2
        },
        {
            question: "Qual forma de onda tem um som 'oco' característico, rico em harmônicos ímpares?",
            options: ["Sine", "Square", "Sawtooth", "Triangle"],
            correct: 1
        },
        {
            question: "O que é um LFO (Low Frequency Oscillator)?",
            options: [
                "Um oscilador de baixa frequência usado para modular parâmetros",
                "Um tipo de filtro",
                "Um efeito de distorção",
                "Um amplificador de graves"
            ],
            correct: 0
        },
        {
            question: "Qual instrumento sintético é conhecido como 'Chimbal'?",
            options: ["Kick", "Snare", "Hi-Hat", "Bass"],
            correct: 2
        },
        {
            question: "A síntese aditiva cria sons complexos através de:",
            options: [
                "Remoção de frequências",
                "Combinação de múltiplas ondas simples",
                "Modulação de frequência",
                "Gravação de amostras"
            ],
            correct: 1
        },
        {
            question: "Qual parte do envelope ADSR é mantida enquanto a nota é segurada e representa um nível (não tempo)?",
            options: ["Attack", "Decay", "Sustain", "Release"],
            correct: 2
        },
        {
            question: "O que é MIDI (Musical Instrument Digital Interface)?",
            options: [
                "Um formato de áudio comprimido",
                "Um protocolo que transmite dados de performance musical (notas, velocidade, duração)",
                "Um tipo de sintetizador",
                "Uma forma de onda especial"
            ],
            correct: 1
        }
    ];

    let currentQuiz = [];
    let userAnswers = [];

    function startQuiz() {
        const shuffled = [...quizDatabase].sort(() => Math.random() - 0.5);
        currentQuiz = shuffled.slice(0, 5);
        userAnswers = new Array(5).fill(null);
        
        displayQuiz();
    }

    function displayQuiz() {
        const container = document.getElementById('quizQuestions');
        container.innerHTML = '';
        
        currentQuiz.forEach((q, index) => {
            const questionDiv = document.createElement('div');
            questionDiv.className = 'question';
            questionDiv.innerHTML = `
                <h3>Pergunta ${index + 1} de 5</h3>
                <p style="font-size: 1.1em; margin: 15px 0;">${q.question}</p>
                <div class="options">
                    ${q.options.map((opt, i) => `
                        <div class="option" onclick="selectAnswer(${index}, ${i})">
                            ${String.fromCharCode(65 + i)}) ${opt}
                        </div>
                    `).join('')}
                </div>
            `;
            container.appendChild(questionDiv);
        });
        
        const submitBtn = document.createElement('button');
        submitBtn.className = 'quiz-btn';
        submitBtn.textContent = '✅ Enviar Respostas e Ver Resultado';
        submitBtn.style.margin = '30px auto';
        submitBtn.style.display = 'block';
        submitBtn.onclick = submitQuiz;
        container.appendChild(submitBtn);
        
        document.getElementById('quizResult').innerHTML = '';
    }

    function selectAnswer(questionIndex, optionIndex) {
        userAnswers[questionIndex] = optionIndex;
        
        const question = document.querySelectorAll('.question')[questionIndex];
        question.querySelectorAll('.option').forEach((opt, i) => {
            opt.classList.remove('selected');
            if (i === optionIndex) {
                opt.classList.add('selected');
            }
        });
    }

    function submitQuiz() {
        if (userAnswers.includes(null)) {
            alert('⚠️ Por favor, responda todas as 5 perguntas antes de enviar!');
            return;
        }
        
        let correct = 0;
        
        currentQuiz.forEach((q, index) => {
            const question = document.querySelectorAll('.question')[index];
            const options = question.querySelectorAll('.option');
            
            options.forEach((opt, i) => {
                opt.style.pointerEvents = 'none';
                opt.style.cursor = 'default';
                if (i === q.correct) {
                    opt.classList.add('correct');
                } else if (i === userAnswers[index] && i !== q.correct) {
                    opt.classList.add('wrong');
                }
            });
            
            if (userAnswers[index] === q.correct) {
                correct++;
            }
        });
        
        const percentage = (correct / 5) * 100;
        const resultDiv = document.getElementById('quizResult');
        
        let message = '';
        let emoji = '';
        if (percentage === 100) {
            message = 'Perfeito! Você domina completamente a síntese sonora!';
            emoji = '🏆';
        } else if (percentage >= 80) {
            message = 'Excelente! Você tem ótimo conhecimento sobre o assunto!';
            emoji = '🎉';
        } else if (percentage >= 60) {
            message = 'Bom trabalho! Continue estudando para aprimorar!';
            emoji = '👍';
        } else {
            message = 'Continue praticando! Revise o conteúdo na seção Teoria.';
            emoji = '📚';
        }
        
        resultDiv.innerHTML = `
            <div class="quiz-result">
                <div style="font-size: 3em; margin-bottom: 15px;">${emoji}</div>
                <h2>${message}</h2>
                <p style="font-size: 1.6em; margin: 20px 0;">Você acertou <strong>${correct}</strong> de <strong>5</strong> perguntas</p>
                <p style="font-size: 1.8em; font-weight: bold;">Percentual: ${percentage.toFixed(0)}%</p>
                <button class="quiz-btn" onclick="startQuiz()" style="margin-top: 25px;">
                    🔄 Fazer Novo Quiz
                </button>
            </div>
        `;
        
        document.querySelector('.quiz-container > .quiz-btn')?.remove();
        resultDiv.scrollIntoView({behavior: 'smooth', block: 'center'});
    }

    // ===== WAVEFORMS =====
    function drawWaveform(canvasId, type) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        const centerY = height / 2;
        
        ctx.clearRect(0, 0, width, height);
        
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, width, height);
        
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        ctx.lineTo(width, centerY);
        ctx.stroke();
        
        ctx.strokeStyle = '#667eea';
        ctx.lineWidth = 3;
        ctx.beginPath();
        
        for (let x = 0; x < width; x++) {
            let y;
            const freq = 0.04;
            
            switch(type) {
                case 'sine':
                    y = centerY + Math.sin(x * freq) * (height / 3);
                    break;
                case 'square':
                    y = centerY + (Math.sin(x * freq) > 0 ? height / 3 : -height / 3);
                    break;
                case 'sawtooth':
                    const sawMod = (x * freq) % (Math.PI * 2);
                    y = centerY + (sawMod - Math.PI) * (height / 3) / Math.PI;
                    break;
                case 'triangle':
                    const triMod = (x * freq) % (Math.PI * 2);
                    y = centerY + (triMod < Math.PI ? 
                        (triMod - Math.PI / 2) : 
                        (Math.PI * 1.5 - triMod)) * (height / 3) / (Math.PI / 2);
                    break;
            }
            
            if (x === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        
        ctx.stroke();
    }

    // ===== WELCOME IMAGE =====
    function createWelcomeImage() {
        const canvas = document.getElementById('welcomeImage');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        
        const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, '#667eea');
        gradient.addColorStop(0.5, '#764ba2');
        gradient.addColorStop(1, '#f093fb');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 4;
        for (let i = 0; i < 8; i++) {
            ctx.beginPath();
            for (let x = 0; x < canvas.width; x += 5) {
                const y = canvas.height / 2 + Math.sin(x * 0.015 + i * 0.7) * (40 + i * 5);
                if (x === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        for (let i = 0; i < 50; i++) {
            const x = Math.random() * canvas.width;
            const y = Math.random() * canvas.height;
            const size = Math.random() * 4 + 2;
            ctx.beginPath();
            ctx.arc(x, y, size, 0, Math.PI * 2);
            ctx.fill();
        }
        
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 15;
        ctx.fillStyle = 'white';
        ctx.font = 'bold 48px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Explore o Mundo da Síntese Sonora', canvas.width / 2, canvas.height / 2 - 20);
        
        ctx.font = '28px Arial';
        ctx.fillText('Sistema Multimídia Interativo', canvas.width / 2, canvas.height / 2 + 30);
        
        ctx.shadowBlur = 0;
    }

    // ===== VIDEO ANIMATION =====
    let videoFrame = 0;
    let videoAnimRunning = false;

    function animateVideo() {
        const canvas = document.getElementById('videoCanvas');
        if (!canvas || !canvas.offsetParent) {
            videoAnimRunning = false;
            return;
        }
        
        videoAnimRunning = true;
        const ctx = canvas.getContext('2d');
        
        const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
        gradient.addColorStop(0, '#000814');
        gradient.addColorStop(1, '#1a1a2e');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        const barCount = 60;
        const barWidth = canvas.width / barCount;
        
        for (let i = 0; i < barCount; i++) {
            const height = Math.abs(Math.sin(videoFrame * 0.08 + i * 0.4)) * 250;
            const hue = (i * 6 + videoFrame * 2) % 360;
            ctx.fillStyle = `hsl(${hue}, 70%, 60%)`;
            ctx.fillRect(i * barWidth, canvas.height - height, barWidth - 2, height);
        }
        
        const waveforms = [
            {color: '#667eea', offset: 0, amp: 80},
            {color: '#f093fb', offset: 2, amp: 60},
            {color: '#f5576c', offset: 4, amp: 100}
        ];
        
        waveforms.forEach(wave => {
            ctx.strokeStyle = wave.color;
            ctx.lineWidth = 3;
            ctx.shadowColor = wave.color;
            ctx.shadowBlur = 15;
            ctx.beginPath();
            
            for (let x = 0; x < canvas.width; x += 3) {
                const y = canvas.height / 2 + 
                         Math.sin(x * 0.02 + videoFrame * 0.08 + wave.offset) * wave.amp;
                if (x === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        });
        
        ctx.shadowBlur = 0;
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        for (let i = 0; i < 20; i++) {
            const x = (videoFrame * 3 + i * 60) % canvas.width;
            const y = canvas.height / 2 + Math.sin(videoFrame * 0.1 + i) * 100;
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
        }
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.font = 'bold 24px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Visualização de Síntese em Tempo Real', canvas.width / 2, 40);
        
        videoFrame++;
        requestAnimationFrame(animateVideo);
    }

    // ===== PRINTS MIDI =====
    function createMIDIPrint1() {
        const canvas = document.getElementById('midiPrint1');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        
        ctx.fillStyle = '#2d2d2d';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, canvas.width, 40);
        ctx.fillStyle = '#fff';
        ctx.font = '16px Arial';
        ctx.fillText('Arquivo  Editar  Ver  Ferramentas  Ajuda', 10, 25);
        
        ctx.fillStyle = '#252525';
        ctx.fillRect(0, 40, 200, canvas.height - 40);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px Arial';
        ctx.fillText('📁 Arquivos', 10, 65);
        
        ctx.fillStyle = '#667eea';
        ctx.fillRect(10, 80, 180, 30);
        ctx.fillStyle = '#fff';
        ctx.fillText('🎵 musica_demo.mid', 20, 100);
        
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 20px Arial';
        ctx.fillText('Abrir Arquivo MIDI', 250, 100);
        
        ctx.font = '16px Arial';
        ctx.fillStyle = '#aaa';
        ctx.fillText('1. Vá em Arquivo > Abrir', 250, 140);
        ctx.fillText('2. Selecione o arquivo .mid', 250, 170);
        ctx.fillText('3. Clique em "Abrir"', 250, 200);
    ctx.fillStyle = '#667eea';
    ctx.fillRect(250, 230, 120, 100);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 48px Arial';
    ctx.fillText('♪', 285, 295);
}

function createMIDIPrint2() {
    const canvas = document.getElementById('midiPrint2');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#2d2d2d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, 50);
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    for (let i = 0; i < 16; i++) {
        const x = i * 50;
        ctx.beginPath();
        ctx.moveTo(x, 40);
        ctx.lineTo(x, 50);
        ctx.stroke();
        ctx.fillStyle = '#aaa';
        ctx.font = '12px Arial';
        ctx.fillText(i, x + 5, 35);
    }
    
    const tracks = ['🎹 Piano', '🎸 Guitarra', '🥁 Bateria', '🎺 Trompete'];
    let y = 70;
    
    tracks.forEach((track, i) => {
        ctx.fillStyle = '#252525';
        ctx.fillRect(0, y, 150, 70);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px Arial';
        ctx.fillText(track, 10, y + 25);
        ctx.fillStyle = '#aaa';
        ctx.font = '11px Arial';
        ctx.fillText(`Canal ${i + 1}`, 10, y + 45);
        
        ctx.fillStyle = '#3a3a3a';
        ctx.fillRect(150, y, canvas.width - 150, 70);
        
        const colors = ['#667eea', '#f093fb', '#10b981', '#f59e0b'];
        for (let j = 0; j < 8; j++) {
            ctx.fillStyle = colors[i];
            ctx.fillRect(150 + j * 80 + 10, y + 20, 60, 30);
        }
        
        y += 80;
    });
}

function createMIDIPrint3() {
    const canvas = document.getElementById('midiPrint3');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#2d2d2d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, 50);
    
    const tracks = ['🎹 Piano', '🎸 Guitarra', '🥁 Bateria', '🎺 Trompete'];
    let y = 70;
    
    tracks.forEach((track, i) => {
        const isSelected = i === 1;
        
        ctx.fillStyle = isSelected ? '#4a3a5a' : '#252525';
        ctx.fillRect(0, y, 150, 70);
        
        if (isSelected) {
            ctx.strokeStyle = '#f093fb';
            ctx.lineWidth = 3;
            ctx.strokeRect(0, y, canvas.width, 70);
        }
        
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px Arial';
        ctx.fillText(track, 10, y + 25);
        
        ctx.fillStyle = '#3a3a3a';
        ctx.fillRect(150, y, canvas.width - 150, 70);
        
        const colors = ['#667eea', '#f093fb', '#10b981', '#f59e0b'];
        for (let j = 0; j < 6; j++) {
            ctx.fillStyle = colors[i];
            ctx.fillRect(150 + j * 100 + 10, y + 20, 70, 30);
        }
        
        y += 80;
    });
    
    ctx.fillStyle = 'rgba(240, 147, 251, 0.3)';
    ctx.fillRect(0, 150, canvas.width, 70);
}

function createMIDIPrint4() {
    const canvas = document.getElementById('midiPrint4');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#2d2d2d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = '#4a3a5a';
    ctx.fillRect(0, 100, 150, 70);
    ctx.strokeStyle = '#f093fb';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 100, 150, 70);
    
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px Arial';
    ctx.fillText('🎸 Guitarra', 10, 130);
    
    ctx.fillStyle = '#fff';
    ctx.fillRect(200, 100, 300, 40);
    ctx.fillStyle = '#000';
    ctx.font = '14px Arial';
    ctx.fillText('Instrumento: Guitarra Elétrica ▼', 210, 125);
    
    ctx.fillStyle = '#f8f8f8';
    ctx.fillRect(200, 140, 300, 200);
    ctx.strokeStyle = '#ccc';
    ctx.strokeRect(200, 140, 300, 200);
    
    const instruments = [
        'Piano Acústico',
        'Violão (Nylon)',
        'Guitarra Elétrica ✓',
        'Baixo Elétrico',
        'Violino',
        'Trompete',
        'Sax Alto'
    ];
    
    instruments.forEach((inst, i) => {
        if (inst.includes('✓')) {
            ctx.fillStyle = '#e0e0ff';
            ctx.fillRect(200, 140 + i * 28, 300, 28);
        }
        ctx.fillStyle = '#000';
        ctx.font = '13px Arial';
        ctx.fillText(inst, 210, 160 + i * 28);
    });
}

function createMIDIPrint5() {
    const canvas = document.getElementById('midiPrint5');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#2d2d2d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = '#4a3a5a';
    ctx.fillRect(0, 100, 150, 70);
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 100, 150, 70);
    
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px Arial';
    ctx.fillText('🎸 → 🎹', 10, 130);
    
    ctx.fillStyle = '#fff';
    ctx.fillRect(200, 100, 300, 40);
    ctx.fillStyle = '#000';
    ctx.font = '14px Arial';
    ctx.fillText('Instrumento: Piano Acústico ▼', 210, 125);
    
    ctx.fillStyle = '#f8f8f8';
    ctx.fillRect(200, 140, 300, 200);
    ctx.strokeStyle = '#ccc';
    ctx.strokeRect(200, 140, 300, 200);
    
    const instruments = [
        'Piano Acústico ✓',
        'Violão (Nylon)',
        'Guitarra Elétrica',
        'Baixo Elétrico',
        'Violino',
        'Trompete',
        'Sax Alto'
    ];
    
    instruments.forEach((inst, i) => {
        if (inst.includes('✓')) {
            ctx.fillStyle = '#d0f0d0';
            ctx.fillRect(200, 140 + i * 28, 300, 28);
        }
        ctx.fillStyle = '#000';
        ctx.font = '13px Arial';
        ctx.fillText(inst, 210, 160 + i * 28);
    });
    
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 18px Arial';
    ctx.fillText('✓ Instrumento alterado!', 200, 360);
}

function createMIDIPrint6() {
    const canvas = document.getElementById('midiPrint6');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#2d2d2d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, 50);
    
    const tracks = ['🎹 Piano', '🎹 Piano (antes: Guitarra)', '🥁 Bateria', '🎺 Trompete'];
    let y = 70;
    
    tracks.forEach((track, i) => {
        const isChanged = i === 1;
        
        ctx.fillStyle = isChanged ? '#1a4a3a' : '#252525';
        ctx.fillRect(0, y, 200, 70);
        
        if (isChanged) {
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 3;
            ctx.strokeRect(0, y, canvas.width, 70);
        }
        
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px Arial';
        ctx.fillText(track, 10, y + 25);
        
        ctx.fillStyle = '#3a3a3a';
        ctx.fillRect(200, y, canvas.width - 200, 70);
        
        const colors = ['#667eea', '#10b981', '#10b981', '#f59e0b'];
        for (let j = 0; j < 6; j++) {
            ctx.fillStyle = colors[i];
            ctx.fillRect(200 + j * 100 + 10, y + 20, 70, 30);
        }
        
        y += 80;
    });
    
    ctx.fillStyle = 'rgba(16, 185, 129, 0.2)';
    ctx.fillRect(10, 10, 350, 30);
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 16px Arial';
    ctx.fillText('✓ Alteração concluída com sucesso!', 20, 30);
}

// ===== INITIALIZATION =====
window.addEventListener('load', function() {
    drawWaveform('sineWave', 'sine');
    drawWaveform('squareWave', 'square');
    drawWaveform('sawWave', 'sawtooth');
    drawWaveform('triangleWave', 'triangle');
    
    createWelcomeImage();
    
    createMIDIPrint1();
    createMIDIPrint2();
    createMIDIPrint3();
    createMIDIPrint4();
    createMIDIPrint5();
    createMIDIPrint6();
    
    setTimeout(() => {
        if (!videoAnimRunning) animateVideo();
    }, 500);
    
    initAudioSamples();
    
    document.body.addEventListener('click', async function initAudio() {
        if (!audioContext) {
            await initMIDISynths();
        }
        document.body.removeEventListener('click', initAudio);
    }, { once: true });
});

const originalShowSection = showSection;
showSection = function(sectionId) {
    originalShowSection.call(this, sectionId);
    if (sectionId === 'learn' && !videoAnimRunning) {
        setTimeout(() => animateVideo(), 100);
    }
};