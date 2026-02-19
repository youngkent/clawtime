/* AVATAR_META {"name": "Lobster", "emoji": "🦞", "description": "Default lobster", "color": "f97316"} */

(function() {
  'use strict';

  var scene, camera, renderer, character;
  var leftEye, rightEye, leftPupil, rightPupil, mouth;
  var leftClaw, rightClaw;
  var leftAntenna, rightAntenna;
  var clock = new THREE.Clock();
  var currentState = 'idle';
  var connectionState = 'connecting';
  var isInitialized = false;
  var userRotationY = 0; // Manual rotation from drag
  var avatarFlash = document.getElementById('avatarFlash');
  var thinkingStartTime = 0;
  var workingTransitionMs = 3000;

  var statusRing, statusRingMat, platformMat, outerGlowMat;

  // Get theme accent color from config, convert hex to RGB
  function getAccentRGB() {
    var hex = (window.CFG && window.CFG.themeAccent) || 'f97316';
    var r = parseInt(hex.slice(0, 2), 16) / 255;
    var g = parseInt(hex.slice(2, 4), 16) / 255;
    var b = parseInt(hex.slice(4, 6), 16) / 255;
    return { r: r, g: g, b: b };
  }
  
  // Dim version of accent for offline
  function getDimAccent() {
    var c = getAccentRGB();
    return { r: c.r * 0.4, g: c.g * 0.4, b: c.b * 0.4 };
  }
  
  var connColors = {
    online:     null, // Will use accent color
    connecting: null, // Will use accent color (pulsing)
    offline:    null  // Will use dim accent
  };
  var connCurrent = { r: 0.5, g: 0.5, b: 0.5 };
  var connTarget  = { r: 0.5, g: 0.5, b: 0.5 };

  // ─── Scene Setup ───
  function initScene() {
    if (isInitialized) return;

    var container = document.getElementById('avatarCanvas');
    if (!container) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1318);

    var w = container.clientWidth;
    var h = container.clientHeight;
    camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    adjustCameraForPanel(w, h);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    var ambient = new THREE.AmbientLight(0x606080, 1.5);
    scene.add(ambient);

    var mainLight = new THREE.DirectionalLight(0xffffff, 2.0);
    mainLight.position.set(4, 10, 6);
    mainLight.castShadow = true;
    scene.add(mainLight);

    var fillLight = new THREE.DirectionalLight(0x88aaff, 0.8);
    fillLight.position.set(-4, 3, -4);
    scene.add(fillLight);
    
    // Front spotlight for face
    var frontLight = new THREE.DirectionalLight(0xffffff, 1.0);
    frontLight.position.set(0, 5, 10);
    scene.add(frontLight);

    character = new THREE.Group();
    buildCharacter();
    scene.add(character);
    storeOriginalColors();

    // ─── Platform Design (Round) ───
    var accentHex = parseInt((window.CFG && window.CFG.themeAccent) || 'f97316', 16);
    var platformGroup = new THREE.Group();
    
    // Base platform (dark, solid circle)
    var baseGeo = new THREE.CircleGeometry(3.0, 64);
    var baseMat = new THREE.MeshLambertMaterial({ color: 0x1a1d24 });
    var basePlatform = new THREE.Mesh(baseGeo, baseMat);
    basePlatform.rotation.x = -Math.PI / 2;
    basePlatform.position.y = -0.02;
    platformGroup.add(basePlatform);
    
    // Inner raised platform
    var innerGeo = new THREE.CircleGeometry(2.5, 64);
    var innerMat = new THREE.MeshLambertMaterial({ color: 0x252a33 });
    var innerPlatform = new THREE.Mesh(innerGeo, innerMat);
    innerPlatform.rotation.x = -Math.PI / 2;
    innerPlatform.position.y = 0;
    platformGroup.add(innerPlatform);
    
    // Status glow surface (color changes with connection state)
    var glowGeo = new THREE.CircleGeometry(2.2, 64);
    platformMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.15
    });
    var glowSurface = new THREE.Mesh(glowGeo, platformMat);
    glowSurface.rotation.x = -Math.PI / 2;
    glowSurface.position.y = 0.01;
    platformGroup.add(glowSurface);
    
    // Inner accent ring
    var innerRingGeo = new THREE.RingGeometry(1.8, 1.9, 64);
    var innerRingMat = new THREE.MeshBasicMaterial({
      color: accentHex,
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide
    });
    var innerRing = new THREE.Mesh(innerRingGeo, innerRingMat);
    innerRing.rotation.x = -Math.PI / 2;
    innerRing.position.y = 0.02;
    platformGroup.add(innerRing);
    
    // Main status ring (accent color, glowing edge)
    var ringGeo = new THREE.RingGeometry(2.35, 2.55, 64);
    statusRingMat = new THREE.MeshBasicMaterial({
      color: accentHex,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide
    });
    statusRing = new THREE.Mesh(ringGeo, statusRingMat);
    statusRing.rotation.x = -Math.PI / 2;
    statusRing.position.y = 0.02;
    platformGroup.add(statusRing);
    
    // Outer soft glow
    var outerGlowGeo = new THREE.RingGeometry(2.5, 3.5, 64);
    outerGlowMat = new THREE.MeshBasicMaterial({
      color: accentHex,
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide
    });
    var outerGlow = new THREE.Mesh(outerGlowGeo, outerGlowMat);
    outerGlow.rotation.x = -Math.PI / 2;
    outerGlow.position.y = -0.03;
    platformGroup.add(outerGlow);
    
    scene.add(platformGroup);

    isInitialized = true;
    animate();
    
    // Drag to rotate character
    var dragActive = false, dragLastX = 0;
    var canvas = renderer.domElement;
    canvas.style.cursor = 'grab';
    canvas.addEventListener('mousedown', function(e) {
      e.stopPropagation(); // Prevent avatar panel click handler
      dragActive = true;
      dragLastX = e.clientX;
      canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', function(e) {
      if (!dragActive) return;
      userRotationY += (e.clientX - dragLastX) * 0.01;
      dragLastX = e.clientX;
    });
    window.addEventListener('mouseup', function() {
      dragActive = false;
      canvas.style.cursor = 'grab';
    });
    canvas.addEventListener('touchstart', function(e) {
      e.stopPropagation();
      if (e.touches.length === 1) { dragActive = true; dragLastX = e.touches[0].clientX; }
    }, { passive: false });
    window.addEventListener('touchmove', function(e) {
      if (!dragActive || e.touches.length !== 1) return;
      userRotationY += (e.touches[0].clientX - dragLastX) * 0.01;
      dragLastX = e.touches[0].clientX;
    }, { passive: true });
    window.addEventListener('touchend', function() { dragActive = false; });
    canvas.addEventListener('dblclick', function(e) {
      e.stopPropagation();
      userRotationY = 0;
    });
    
    window.addEventListener('resize', function() {
      var w = container.clientWidth;
      var h = container.clientHeight;
      camera.aspect = w / h;
      adjustCameraForPanel(w, h);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
  }

  function adjustCameraForPanel(w, h) {
    var ratio = h / w;
    // Dynamic zoom based on aspect ratio
    // ratio < 1 = wide panel = zoom in (smaller z)
    // ratio > 1 = tall panel = zoom out (larger z)
    var z;
    if (ratio < 0.8) {
      // Wide panel - zoom in close
      z = 14;
    } else if (ratio < 1.2) {
      // Square-ish - medium zoom
      z = 16;
    } else {
      // Tall panel - zoom out proportionally
      z = 16 + (ratio - 1.2) * 10;
    }
    z = Math.max(12, Math.min(z, 40)); // Clamp between 12 and 40
    camera.position.set(0, 4, z);
    camera.lookAt(0, 3, 0);
  }

  // ─── Build Lobster Character ───
  function buildCharacter() {
    var red     = 0xdc2626;  // Main lobster red
    var darkRed = 0xb91c1c;  // Darker red for depth
    var lightRed = 0xef4444; // Lighter red for highlights
    var cream   = 0xfef3c7;  // Belly/underside
    var white   = 0xffffff;
    var dark    = 0x1a1a2e;
    var blue    = 0x3b82f6;  // Eye color

    function box(w, h, d, color, emissive) {
      var geo = new THREE.BoxGeometry(w, h, d);
      var opts = { color: color };
      if (emissive) {
        opts.emissive = emissive;
        opts.emissiveIntensity = 0.3;
      }
      return new THREE.Mesh(geo, new THREE.MeshLambertMaterial(opts));
    }

    // Tail segments (behind body)
    var tail1 = box(1.6, 0.8, 0.9, darkRed);
    tail1.position.set(0, 1.5, -1.2);
    character.add(tail1);

    var tail2 = box(1.3, 0.6, 0.8, darkRed);
    tail2.position.set(0, 1.3, -1.9);
    character.add(tail2);

    var tailFin = box(1.8, 0.3, 0.5, red);
    tailFin.position.set(0, 1.1, -2.4);
    character.add(tailFin);

    // Legs (6 small legs)
    for (var i = 0; i < 3; i++) {
      var legL = box(0.3, 0.8, 0.3, darkRed);
      legL.position.set(-1.0, 0.4, 0.5 - i * 0.6);
      legL.rotation.z = 0.3;
      character.add(legL);

      var legR = box(0.3, 0.8, 0.3, darkRed);
      legR.position.set(1.0, 0.4, 0.5 - i * 0.6);
      legR.rotation.z = -0.3;
      character.add(legR);
    }

    // Body
    var body = box(2.2, 2.0, 2.0, red);
    body.position.set(0, 2.2, 0);
    character.add(body);

    var bellyPatch = box(1.4, 1.4, 0.1, cream);
    bellyPatch.position.set(0, 2.0, 1.06);
    character.add(bellyPatch);

    // Claws (arms with pincers) — BIG CLAWS!
    // Left claw arm
    var laArm = box(0.8, 1.8, 0.6, darkRed);
    laArm.position.set(-1.8, 2.8, 0.3);
    laArm.rotation.z = 0.4;
    character.add(laArm);
    window._leftArm = laArm;
    
    // Left claw (pincer) — CHUNKY
    leftClaw = new THREE.Group();
    var clawTop = box(1.6, 0.5, 1.2, red);
    clawTop.position.set(0, 0.4, 0);
    leftClaw.add(clawTop);
    var clawBot = box(1.6, 0.5, 1.2, red);
    clawBot.position.set(0, -0.2, 0);
    leftClaw.add(clawBot);
    leftClaw.position.set(-2.8, 3.6, 0.5);
    leftClaw.rotation.z = 0.5;
    character.add(leftClaw);

    // Right claw arm
    var raArm = box(0.8, 1.8, 0.6, darkRed);
    raArm.position.set(1.8, 2.8, 0.3);
    raArm.rotation.z = -0.4;
    character.add(raArm);
    window._rightArm = raArm;
    
    // Right claw (pincer) — CHUNKY
    rightClaw = new THREE.Group();
    var clawTop2 = box(1.6, 0.5, 1.2, red);
    clawTop2.position.set(0, 0.4, 0);
    rightClaw.add(clawTop2);
    var clawBot2 = box(1.6, 0.5, 1.2, red);
    clawBot2.position.set(0, -0.2, 0);
    rightClaw.add(clawBot2);
    rightClaw.position.set(2.8, 3.6, 0.5);
    rightClaw.rotation.z = -0.5;
    character.add(rightClaw);

    // Head
    var head = box(2.4, 2.0, 1.8, red);
    head.position.set(0, 4.5, 0.2);
    character.add(head);

    // Eye stalks
    var leftStalk = box(0.3, 0.6, 0.3, darkRed);
    leftStalk.position.set(-0.7, 5.7, 0.3);
    character.add(leftStalk);

    var rightStalk = box(0.3, 0.6, 0.3, darkRed);
    rightStalk.position.set(0.7, 5.7, 0.3);
    character.add(rightStalk);

    // Eyes (on stalks)
    var eyeGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    var eyeMat = new THREE.MeshLambertMaterial({ color: white });

    leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-0.7, 6.1, 0.3);
    character.add(leftEye);

    rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.7, 6.1, 0.3);
    character.add(rightEye);

    // Pupils
    var pupilGeo = new THREE.BoxGeometry(0.25, 0.25, 0.2);
    var pupilMat = new THREE.MeshLambertMaterial({ color: blue });

    leftPupil = new THREE.Mesh(pupilGeo, pupilMat);
    leftPupil.position.set(-0.7, 6.1, 0.56);
    character.add(leftPupil);

    rightPupil = new THREE.Mesh(pupilGeo, pupilMat);
    rightPupil.position.set(0.7, 6.1, 0.56);
    character.add(rightPupil);

    // Antennae
    leftAntenna = new THREE.Group();
    var ant1 = box(0.1, 1.5, 0.1, darkRed);
    ant1.position.set(0, 0.75, 0);
    ant1.rotation.z = 0.3;
    ant1.rotation.x = -0.2;
    leftAntenna.add(ant1);
    leftAntenna.position.set(-0.5, 5.5, 0.8);
    character.add(leftAntenna);

    rightAntenna = new THREE.Group();
    var ant2 = box(0.1, 1.5, 0.1, darkRed);
    ant2.position.set(0, 0.75, 0);
    ant2.rotation.z = -0.3;
    ant2.rotation.x = -0.2;
    rightAntenna.add(ant2);
    rightAntenna.position.set(0.5, 5.5, 0.8);
    character.add(rightAntenna);

    // Mouth - on the face, below eyes
    mouth = box(0.6, 0.35, 0.2, dark);
    mouth.position.set(0, 4.6, 1.3);
    mouth.visible = false;
    character.add(mouth);

    // Laptop (for working/coding state) - big and prominent, screen faces viewer
    var laptopBase = box(2.8, 0.15, 1.8, 0x1f2937);
    laptopBase.position.set(0, 0.3, 3.2);
    character.add(laptopBase);
    
    // Laptop screen frame - positioned past base so it faces camera
    var laptopScreen = box(2.6, 1.8, 0.1, 0x111827);
    laptopScreen.position.set(0, 1.4, 4.2);
    laptopScreen.rotation.x = 0.3; // Tilt toward viewer
    character.add(laptopScreen);
    
    // Screen display (glowing) - on the front of screen frame
    var laptopDisplay = box(2.3, 1.5, 0.02, 0x0ea5e9, 0x0ea5e9);
    laptopDisplay.position.set(0, 1.4, 4.14);
    laptopDisplay.rotation.x = 0.3;
    character.add(laptopDisplay);
    
    // Code lines on screen (visual detail) - on front face
    var codeLine1 = box(1.8, 0.08, 0.01, 0x4ade80, 0x4ade80);
    codeLine1.position.set(-0.2, 1.7, 4.1);
    codeLine1.rotation.x = 0.3;
    character.add(codeLine1);
    
    var codeLine2 = box(1.4, 0.08, 0.01, 0xfbbf24, 0xfbbf24);
    codeLine2.position.set(0, 1.5, 4.1);
    codeLine2.rotation.x = 0.3;
    character.add(codeLine2);
    
    var codeLine3 = box(2.0, 0.08, 0.01, 0x60a5fa, 0x60a5fa);
    codeLine3.position.set(0.1, 1.3, 4.1);
    codeLine3.rotation.x = 0.3;
    character.add(codeLine3);
    
    // Keyboard with keys - between lobster and screen
    var keyboard = box(2.2, 0.05, 1.0, 0x374151);
    keyboard.position.set(0, 0.4, 3.2);
    character.add(keyboard);
    
    // Key rows
    for (var row = 0; row < 3; row++) {
      for (var k = 0; k < 8; k++) {
        var key = box(0.22, 0.04, 0.22, 0x4b5563);
        key.position.set(-0.85 + k * 0.25, 0.45, 2.85 + row * 0.28);
        character.add(key);
        if (!window._keyParts) window._keyParts = [];
        window._keyParts.push(key);
      }
    }
    
    // Screen glow light (illuminates from screen toward viewer)
    var screenGlow = new THREE.PointLight(0x0ea5e9, 0, 5);
    screenGlow.position.set(0, 2, 4.5);
    character.add(screenGlow);
    window._screenGlow = screenGlow;
    
    // Store laptop parts for visibility toggle
    window._laptopParts = [laptopBase, laptopScreen, laptopDisplay, codeLine1, codeLine2, codeLine3, keyboard];
    window._laptopParts = window._laptopParts.concat(window._keyParts || []);
    // Hide by default
    window._laptopParts.forEach(function(p) { p.visible = false; });

    character.userData.parts = {
      body: body, bellyPatch: bellyPatch,
      head: head, leftClaw: leftClaw, rightClaw: rightClaw
    };
  }

  var originalColors = {};
  function storeOriginalColors() {
    if (!character) return;
    character.traverse(function(child) {
      if (child.isMesh && child.material) {
        originalColors[child.uuid] = child.material.color.getHex();
      }
    });
  }

  function setGrayscale(enable) {
    if (!character) return;
    character.traverse(function(child) {
      if (child.isMesh && child.material && originalColors[child.uuid] !== undefined) {
        if (enable) {
          var c = new THREE.Color(originalColors[child.uuid]);
          var gray = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
          child.material.color.setRGB(gray, gray, gray);
        } else {
          child.material.color.setHex(originalColors[child.uuid]);
        }
      }
    });
  }

  // ─── Animation Loop ───
  function animate() {
    requestAnimationFrame(animate);
    var delta = clock.getDelta();
    var elapsed = clock.getElapsedTime();

    // Connection status color interpolation
    connCurrent.r += (connTarget.r - connCurrent.r) * 0.05;
    connCurrent.g += (connTarget.g - connCurrent.g) * 0.05;
    connCurrent.b += (connTarget.b - connCurrent.b) * 0.05;
    if (statusRingMat) statusRingMat.color.setRGB(connCurrent.r, connCurrent.g, connCurrent.b);
    if (outerGlowMat) outerGlowMat.color.setRGB(connCurrent.r, connCurrent.g, connCurrent.b);

    // Auto-transition from thinking to working
    if (currentState === 'thinking') {
      var thinkingDuration = Date.now() - thinkingStartTime;
      if (thinkingDuration > workingTransitionMs) {
        currentState = 'working';
      }
    }

    // State-based animations
    // Reset character and features for clean state transitions
    character.position.x = 0;
    character.rotation.y = userRotationY; // Preserve user drag rotation
    character.rotation.z = 0;
    if (currentState !== 'working' && currentState !== 'coding') {
      character.rotation.x = 0;
      if (leftClaw) leftClaw.position.set(-2.4, 3.5, 0.5);
      if (rightClaw) rightClaw.position.set(2.4, 3.5, 0.5);
      // Reset arms to default position
      if (window._leftArm) { window._leftArm.position.set(-1.6, 2.8, 0.3); window._leftArm.rotation.z = 0.4; window._leftArm.rotation.x = 0; }
      if (window._rightArm) { window._rightArm.position.set(1.6, 2.8, 0.3); window._rightArm.rotation.z = -0.4; window._rightArm.rotation.x = 0; }
    }
    // Reset eyes to default
    if (leftPupil) { leftPupil.position.set(-0.7, 6.1, 0.56); }
    if (rightPupil) { rightPupil.position.set(0.7, 6.1, 0.56); }
    if (leftEye) leftEye.scale.set(1, 1, 1);
    if (rightEye) rightEye.scale.set(1, 1, 1);
    // Reset antennae
    if (leftAntenna) { leftAntenna.rotation.x = 0; leftAntenna.rotation.z = 0.3; }
    if (rightAntenna) { rightAntenna.rotation.x = 0; rightAntenna.rotation.z = -0.3; }
    
    if (currentState === 'idle') {
      // Gentle bob and claw movement, eyes look around
      character.position.y = Math.sin(elapsed * 1.5) * 0.08;
      if (leftClaw) leftClaw.rotation.z = 0.5 + Math.sin(elapsed * 2) * 0.1;
      if (rightClaw) rightClaw.rotation.z = -0.5 - Math.sin(elapsed * 2) * 0.1;
      if (leftAntenna) leftAntenna.rotation.x = Math.sin(elapsed * 3) * 0.1;
      if (rightAntenna) rightAntenna.rotation.x = Math.sin(elapsed * 3 + 1) * 0.1;
      // Eyes wander slowly
      if (leftPupil) leftPupil.position.x = -0.7 + Math.sin(elapsed * 0.5) * 0.08;
      if (rightPupil) rightPupil.position.x = 0.7 + Math.sin(elapsed * 0.5) * 0.08;
      if (leftEye) leftEye.scale.y = 1;
      if (rightEye) rightEye.scale.y = 1;
    } else if (currentState === 'thinking') {
      // Looking up, claws together like pondering
      character.position.y = Math.sin(elapsed * 1) * 0.03;
      character.rotation.z = Math.sin(elapsed * 0.8) * 0.05; // Slight head tilt
      if (leftClaw) leftClaw.rotation.z = 0.2 + Math.sin(elapsed * 3) * 0.15;
      if (rightClaw) rightClaw.rotation.z = -0.2 - Math.sin(elapsed * 3) * 0.15;
      // Eyes look up
      if (leftPupil) leftPupil.position.y = 6.2 + Math.sin(elapsed * 2) * 0.05;
      if (rightPupil) rightPupil.position.y = 6.2 + Math.sin(elapsed * 2) * 0.05;
      // Antennae twitch
      if (leftAntenna) leftAntenna.rotation.z = 0.3 + Math.sin(elapsed * 5) * 0.1;
      if (rightAntenna) rightAntenna.rotation.z = -0.3 - Math.sin(elapsed * 5) * 0.1;
    } else if (currentState === 'talking') {
      // Energetic! Mouth moves big, gesturing with claws
      character.position.y = Math.sin(elapsed * 4) * 0.12;
      character.rotation.y = userRotationY + Math.sin(elapsed * 2) * 0.08;
      if (leftClaw) leftClaw.rotation.z = 0.6 + Math.sin(elapsed * 7) * 0.25;
      if (rightClaw) rightClaw.rotation.z = -0.6 - Math.sin(elapsed * 7 + 1) * 0.25;
      if (mouth) {
        mouth.visible = true;
        // Mouth animation
        mouth.scale.y = 0.5 + Math.abs(Math.sin(elapsed * 12)) * 1.2;
        mouth.scale.x = 0.8 + Math.abs(Math.sin(elapsed * 10)) * 0.4;
        mouth.position.y = 4.6 + Math.sin(elapsed * 12) * 0.06;
      }
      // Eyes wide and engaged
      if (leftEye) leftEye.scale.y = 1.1;
      if (rightEye) rightEye.scale.y = 1.1;
      if (leftPupil) leftPupil.position.z = 0.6;
      if (rightPupil) rightPupil.position.z = 0.6;
    } else if (currentState === 'happy' || currentState === 'celebrating') {
      // SUPER excited! Big bounces, waving claws high
      character.position.y = Math.abs(Math.sin(elapsed * 6)) * 0.5;
      character.rotation.y = userRotationY + Math.sin(elapsed * 4) * 0.2;
      character.rotation.z = Math.sin(elapsed * 3) * 0.1;
      if (leftClaw) {
        leftClaw.rotation.z = 1.2 + Math.sin(elapsed * 10) * 0.4;
        leftClaw.position.y = 4.0 + Math.sin(elapsed * 8) * 0.3;
      }
      if (rightClaw) {
        rightClaw.rotation.z = -1.2 - Math.sin(elapsed * 10) * 0.4;
        rightClaw.position.y = 4.0 + Math.sin(elapsed * 8 + 0.5) * 0.3;
      }
      // Big happy eyes
      if (leftEye) leftEye.scale.y = 1.2;
      if (rightEye) rightEye.scale.y = 1.2;
      // Antennae bounce
      if (leftAntenna) leftAntenna.rotation.x = Math.sin(elapsed * 8) * 0.3;
      if (rightAntenna) rightAntenna.rotation.x = Math.sin(elapsed * 8 + 1) * 0.3;
    } else if (currentState === 'working' || currentState === 'coding') {
      // Leaning forward, intensely focused on laptop
      character.position.y = Math.sin(elapsed * 1.5) * 0.02;
      character.rotation.x = 0.25; // Lean forward
      
      // Arms reaching down to keyboard
      if (window._leftArm) {
        window._leftArm.position.set(-1.2, 1.8, 1.8);
        window._leftArm.rotation.z = 0.1;
        window._leftArm.rotation.x = -0.6;
      }
      if (window._rightArm) {
        window._rightArm.position.set(1.2, 1.8, 1.8);
        window._rightArm.rotation.z = -0.1;
        window._rightArm.rotation.x = -0.6;
      }
      
      // Claws hovering over keyboard, typing rapidly
      if (leftClaw) {
        leftClaw.position.set(-0.8, 0.9, 3.0);
        leftClaw.rotation.z = 0.05;
        leftClaw.rotation.x = -0.3 + Math.sin(elapsed * 15) * 0.08;
        leftClaw.position.y = 0.9 + Math.abs(Math.sin(elapsed * 15)) * 0.12;
      }
      if (rightClaw) {
        rightClaw.position.set(0.8, 0.9, 3.0);
        rightClaw.rotation.z = -0.05;
        rightClaw.rotation.x = -0.3 + Math.sin(elapsed * 15 + 1) * 0.08;
        rightClaw.position.y = 0.9 + Math.abs(Math.sin(elapsed * 15 + 1)) * 0.12;
      }
      
      // Eyes glued to screen
      if (leftPupil) { leftPupil.position.y = 5.85; leftPupil.position.z = 0.65; }
      if (rightPupil) { rightPupil.position.y = 5.85; rightPupil.position.z = 0.65; }
      if (leftEye) leftEye.scale.y = 0.85;
      if (rightEye) rightEye.scale.y = 0.85;
      
      // Screen glow pulses slightly
      if (window._screenGlow) {
        window._screenGlow.intensity = 1.5 + Math.sin(elapsed * 3) * 0.3;
      }
    } else if (currentState === 'sleeping') {
      // Slow breathing, eyes closed (squished), droopy
      character.position.y = Math.sin(elapsed * 0.5) * 0.05;
      character.rotation.x = 0.1; // Slight droop
      // Eyes nearly closed
      if (leftEye) leftEye.scale.y = 0.2;
      if (rightEye) rightEye.scale.y = 0.2;
      // Claws down relaxed
      if (leftClaw) leftClaw.rotation.z = 0.3;
      if (rightClaw) rightClaw.rotation.z = -0.3;
      // Antennae droop
      if (leftAntenna) leftAntenna.rotation.x = 0.4;
      if (rightAntenna) rightAntenna.rotation.x = 0.4;
    } else if (currentState === 'error' || currentState === 'frustrated') {
      // Angry shake, claws up
      character.position.x = Math.sin(elapsed * 25) * 0.15;
      character.position.y = 0.1;
      if (leftClaw) {
        leftClaw.rotation.z = 0.9 + Math.sin(elapsed * 15) * 0.2;
        leftClaw.position.y = 4.0;
      }
      if (rightClaw) {
        rightClaw.rotation.z = -0.9 - Math.sin(elapsed * 15) * 0.2;
        rightClaw.position.y = 4.0;
      }
      // Angry eyes - squished, pupils small
      if (leftEye) leftEye.scale.y = 0.6;
      if (rightEye) rightEye.scale.y = 0.6;
      // Antennae back angrily
      if (leftAntenna) leftAntenna.rotation.z = 0.5;
      if (rightAntenna) rightAntenna.rotation.z = -0.5;
    } else if (currentState === 'listening') {
      // Voice mode - very obvious attentive state like on a FaceTime call
      // Lean forward eagerly with more bounce
      character.position.y = 0.4 + Math.sin(elapsed * 2.5) * 0.15;
      character.position.z = 0.8;
      character.rotation.x = -0.2; // Lean forward more
      character.rotation.z = Math.sin(elapsed * 1.5) * 0.08;
      character.rotation.y = userRotationY + Math.sin(elapsed * 1) * 0.1;
      
      // Very big wide attentive eyes (30% bigger)
      if (leftEye) leftEye.scale.set(1.3, 1.35, 1);
      if (rightEye) rightEye.scale.set(1.3, 1.35, 1);
      
      // Pupils looking forward at camera/speaker, tracking slightly
      if (leftPupil) {
        leftPupil.position.x = -0.7 + Math.sin(elapsed * 0.8) * 0.12;
        leftPupil.position.y = 6.25;
        leftPupil.position.z = 0.75;
      }
      if (rightPupil) {
        rightPupil.position.x = 0.7 + Math.sin(elapsed * 0.8) * 0.12;
        rightPupil.position.y = 6.25;
        rightPupil.position.z = 0.75;
      }
      
      // Claws up high and open - animated gesturing
      if (leftClaw) {
        leftClaw.rotation.z = 0.8 + Math.sin(elapsed * 2.5) * 0.2;
        leftClaw.position.y = 4.2 + Math.sin(elapsed * 2) * 0.15;
        leftClaw.position.x = -2.6;
      }
      if (rightClaw) {
        rightClaw.rotation.z = -0.8 - Math.sin(elapsed * 2.5) * 0.2;
        rightClaw.position.y = 4.2 + Math.sin(elapsed * 2 + 0.5) * 0.15;
        rightClaw.position.x = 2.6;
      }
      
      // Antennae very perked up and actively moving
      if (leftAntenna) {
        leftAntenna.rotation.x = -0.5 + Math.sin(elapsed * 4) * 0.2;
        leftAntenna.rotation.z = Math.sin(elapsed * 3) * 0.1;
      }
      if (rightAntenna) {
        rightAntenna.rotation.x = -0.5 + Math.sin(elapsed * 4 + 0.5) * 0.2;
        rightAntenna.rotation.z = -Math.sin(elapsed * 3) * 0.1;
      }
    }

    // Reset mouth when not talking
    if (currentState !== 'talking' && mouth) {
      mouth.visible = false;
      mouth.scale.y = 1;
    }

    renderer.render(scene, camera);
  }

  // ─── Public API ───
  window.setAvatarState = function(state) {
    if (state === 'thinking') {
      thinkingStartTime = Date.now();
    }
    currentState = state;

    // Show/hide laptop for working/coding states
    var showLaptop = (state === 'working' || state === 'coding');
    if (window._laptopParts) {
      window._laptopParts.forEach(function(part) {
        part.visible = showLaptop;
      });
    }
    // Screen glow on/off
    if (window._screenGlow) {
      window._screenGlow.intensity = showLaptop ? 1.5 : 0;
    }

    if (state === 'error' && avatarFlash) {
      avatarFlash.classList.add('active');
      setTimeout(function() {
        avatarFlash.classList.remove('active');
      }, 300);
    }
  };

  window.setAvatarConnection = function(state) {
    connectionState = state;
    // Use theme accent color dynamically for the ring
    if (state === 'online' || state === 'connecting') {
      connTarget = getAccentRGB();
    } else if (state === 'offline') {
      connTarget = getDimAccent();
    }
    // Platform color shows connection status: green=online, orange=connecting, red=offline
    if (platformMat) {
      if (state === 'online') {
        platformMat.color.setHex(0x22c55e); // Green
        platformMat.opacity = 0.15;
      } else if (state === 'connecting') {
        platformMat.color.setHex(0xf59e0b); // Orange/amber
        platformMat.opacity = 0.12;
      } else if (state === 'reconnecting') {
        platformMat.color.setHex(0xf59e0b); // Orange/amber for reconnecting
        platformMat.opacity = 0.10;
      } else {
        platformMat.color.setHex(0xef4444); // Red
        platformMat.opacity = 0.08;
      }
    }
    setGrayscale(state === 'offline' || state === 'reconnecting');
  };

  window.adjustAvatarCamera = function() {
    if (!camera || !renderer) return;
    var container = document.getElementById('avatarCanvas');
    if (!container) return;
    var w = container.clientWidth;
    var h = container.clientHeight;
    camera.aspect = w / h;
    adjustCameraForPanel(w, h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };

  window.initAvatarScene = initScene;
})();
