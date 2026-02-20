/* AVATAR_META {"name": "Blaze", "emoji": "🔥", "description": "Fire horse with flaming mane", "color": "f97316"} */

(function () {
  "use strict";

  var scene, camera, renderer, character;
  var head, leftEye, rightEye, leftPupil, rightPupil, mouth;
  var maneFlames = [],
    tailFlames = [],
    hoofFlames = [];
  var leftEar, rightEar;
  var clock = new THREE.Clock();
  var currentState = "idle";
  var connectionState = "connecting";
  var isInitialized = false;
  var userRotationY = 0;
  var avatarFlash = document.getElementById("avatarFlash");
  var thinkingStartTime = 0;
  var workingTransitionMs = 3000;

  var statusRing, statusRingMat, platformMat, outerGlowMat;

  function getAccentRGB() {
    var hex = (window.CFG && window.CFG.themeAccent) || "f97316";
    var r = parseInt(hex.slice(0, 2), 16) / 255;
    var g = parseInt(hex.slice(2, 4), 16) / 255;
    var b = parseInt(hex.slice(4, 6), 16) / 255;
    return { r: r, g: g, b: b };
  }

  function getDimAccent() {
    var c = getAccentRGB();
    return { r: c.r * 0.4, g: c.g * 0.4, b: c.b * 0.4 };
  }

  var connCurrent = { r: 0.5, g: 0.5, b: 0.5 };
  var connTarget = { r: 0.5, g: 0.5, b: 0.5 };

  function initScene() {
    if (isInitialized) return;

    var container = document.getElementById("avatarCanvas");
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

    var fillLight = new THREE.DirectionalLight(0xff6600, 0.6);
    fillLight.position.set(-4, 3, -4);
    scene.add(fillLight);

    var frontLight = new THREE.DirectionalLight(0xffffff, 1.0);
    frontLight.position.set(0, 5, 10);
    scene.add(frontLight);

    // Fire glow light
    var fireGlow = new THREE.PointLight(0xff4500, 2, 15);
    fireGlow.position.set(0, 6, 2);
    scene.add(fireGlow);
    window._fireGlow = fireGlow;

    character = new THREE.Group();
    buildCharacter();
    scene.add(character);
    storeOriginalColors();

    // Platform
    var accentHex = parseInt((window.CFG && window.CFG.themeAccent) || "f97316", 16);
    var platformGroup = new THREE.Group();

    var baseGeo = new THREE.CircleGeometry(3.0, 64);
    var baseMat = new THREE.MeshLambertMaterial({ color: 0x1a1d24 });
    var basePlatform = new THREE.Mesh(baseGeo, baseMat);
    basePlatform.rotation.x = -Math.PI / 2;
    basePlatform.position.y = -0.02;
    platformGroup.add(basePlatform);

    var innerGeo = new THREE.CircleGeometry(2.5, 64);
    var innerMat = new THREE.MeshLambertMaterial({ color: 0x252a33 });
    var innerPlatform = new THREE.Mesh(innerGeo, innerMat);
    innerPlatform.rotation.x = -Math.PI / 2;
    innerPlatform.position.y = 0;
    platformGroup.add(innerPlatform);

    var glowGeo = new THREE.CircleGeometry(2.2, 64);
    platformMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.15,
    });
    var glowSurface = new THREE.Mesh(glowGeo, platformMat);
    glowSurface.rotation.x = -Math.PI / 2;
    glowSurface.position.y = 0.01;
    platformGroup.add(glowSurface);

    var innerRingGeo = new THREE.RingGeometry(1.8, 1.9, 64);
    var innerRingMat = new THREE.MeshBasicMaterial({
      color: accentHex,
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
    });
    var innerRing = new THREE.Mesh(innerRingGeo, innerRingMat);
    innerRing.rotation.x = -Math.PI / 2;
    innerRing.position.y = 0.02;
    platformGroup.add(innerRing);

    var ringGeo = new THREE.RingGeometry(2.35, 2.55, 64);
    statusRingMat = new THREE.MeshBasicMaterial({
      color: accentHex,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
    });
    statusRing = new THREE.Mesh(ringGeo, statusRingMat);
    statusRing.rotation.x = -Math.PI / 2;
    statusRing.position.y = 0.02;
    platformGroup.add(statusRing);

    var outerGlowGeo = new THREE.RingGeometry(2.5, 3.5, 64);
    outerGlowMat = new THREE.MeshBasicMaterial({
      color: accentHex,
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
    });
    var outerGlow = new THREE.Mesh(outerGlowGeo, outerGlowMat);
    outerGlow.rotation.x = -Math.PI / 2;
    outerGlow.position.y = -0.03;
    platformGroup.add(outerGlow);

    scene.add(platformGroup);

    isInitialized = true;
    animate();

    // Drag controls
    var dragActive = false,
      dragLastX = 0;
    var canvas = renderer.domElement;
    canvas.style.cursor = "grab";
    canvas.addEventListener("mousedown", function (e) {
      e.stopPropagation();
      dragActive = true;
      dragLastX = e.clientX;
      canvas.style.cursor = "grabbing";
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragActive) return;
      userRotationY += (e.clientX - dragLastX) * 0.01;
      dragLastX = e.clientX;
    });
    window.addEventListener("mouseup", function () {
      dragActive = false;
      canvas.style.cursor = "grab";
    });
    canvas.addEventListener(
      "touchstart",
      function (e) {
        e.stopPropagation();
        if (e.touches.length === 1) {
          dragActive = true;
          dragLastX = e.touches[0].clientX;
        }
      },
      { passive: false },
    );
    window.addEventListener(
      "touchmove",
      function (e) {
        if (!dragActive || e.touches.length !== 1) return;
        userRotationY += (e.touches[0].clientX - dragLastX) * 0.01;
        dragLastX = e.touches[0].clientX;
      },
      { passive: true },
    );
    window.addEventListener("touchend", function () {
      dragActive = false;
    });
    canvas.addEventListener("dblclick", function (e) {
      e.stopPropagation();
      userRotationY = 0;
    });

    window.addEventListener("resize", function () {
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
    var z;
    if (ratio < 0.8) {
      z = 16;
    } else if (ratio < 1.2) {
      z = 18;
    } else {
      z = 18 + (ratio - 1.2) * 10;
    }
    z = Math.max(14, Math.min(z, 40));
    camera.position.set(0, 5, z);
    camera.lookAt(0, 4, 0);
  }

  function buildCharacter() {
    var black = 0x1a1a2e;
    var darkOrange = 0xcc4400;
    var brightOrange = 0xff6600;
    var fireRed = 0xff3300;
    var golden = 0xffaa00;
    var yellow = 0xffcc00;
    var white = 0xffffff;

    function box(w, h, d, color, emissive) {
      var geo = new THREE.BoxGeometry(w, h, d);
      var opts = { color: color };
      if (emissive) {
        opts.emissive = emissive;
        opts.emissiveIntensity = 0.5;
      }
      return new THREE.Mesh(geo, new THREE.MeshLambertMaterial(opts));
    }

    function flame(w, h, d) {
      var geo = new THREE.BoxGeometry(w, h, d);
      var mat = new THREE.MeshBasicMaterial({
        color: orange,
        transparent: true,
        opacity: 0.9,
      });
      return new THREE.Mesh(geo, mat);
    }

    // Legs
    var legPositions = [
      { x: -0.8, z: 1.2 }, // front left
      { x: 0.8, z: 1.2 }, // front right
      { x: -0.8, z: -1.2 }, // back left
      { x: 0.8, z: -1.2 }, // back right
    ];

    window._legs = [];
    legPositions.forEach(function (pos, i) {
      var leg = new THREE.Group();

      // Upper leg
      var upperLeg = box(0.5, 1.5, 0.5, brightOrange);
      upperLeg.position.y = 1.5;
      leg.add(upperLeg);

      // Lower leg
      var lowerLeg = box(0.4, 1.5, 0.4, golden);
      lowerLeg.position.y = 0.5;
      leg.add(lowerLeg);

      // Hoof
      var hoof = box(0.5, 0.3, 0.6, black);
      hoof.position.y = -0.1;
      leg.add(hoof);

      // Hoof flames
      var hoofFlame = flame(0.4, 0.5, 0.4);
      hoofFlame.position.y = -0.3;
      leg.add(hoofFlame);
      hoofFlames.push(hoofFlame);

      leg.position.set(pos.x, 0.2, pos.z);
      character.add(leg);
      window._legs.push(leg);
    });

    // Body
    var body = box(2.2, 2.0, 3.5, brightOrange);
    body.position.set(0, 3.2, 0);
    character.add(body);

    // Chest highlight
    var chest = box(1.8, 1.4, 0.1, golden);
    chest.position.set(0, 3.0, 1.8);
    character.add(chest);

    // Neck
    var neck = box(1.2, 2.0, 1.0, brightOrange);
    neck.position.set(0, 4.8, 1.5);
    neck.rotation.x = -0.3;
    character.add(neck);

    // Head
    head = new THREE.Group();

    var skull = box(1.4, 1.6, 1.8, brightOrange);
    skull.position.set(0, 0, 0);
    head.add(skull);

    // Snout
    var snout = box(1.0, 0.8, 1.2, golden);
    snout.position.set(0, -0.4, 0.9);
    head.add(snout);

    // Nostrils (with embers)
    var nostrilL = box(0.15, 0.1, 0.1, red, red);
    nostrilL.position.set(-0.25, -0.5, 1.5);
    head.add(nostrilL);
    var nostrilR = box(0.15, 0.1, 0.1, red, red);
    nostrilR.position.set(0.25, -0.5, 1.5);
    head.add(nostrilR);
    window._nostrils = [nostrilL, nostrilR];

    // Eyes
    var eyeGeo = new THREE.BoxGeometry(0.4, 0.35, 0.2);
    var eyeMat = new THREE.MeshLambertMaterial({ color: white });

    leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-0.45, 0.2, 0.7);
    head.add(leftEye);

    rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.45, 0.2, 0.7);
    head.add(rightEye);

    // Pupils (fiery orange)
    var pupilGeo = new THREE.BoxGeometry(0.2, 0.2, 0.1);
    var pupilMat = new THREE.MeshBasicMaterial({
      color: orange,
      emissive: orange,
      emissiveIntensity: 0.8,
    });

    leftPupil = new THREE.Mesh(pupilGeo, pupilMat);
    leftPupil.position.set(-0.45, 0.2, 0.82);
    head.add(leftPupil);

    rightPupil = new THREE.Mesh(pupilGeo, pupilMat);
    rightPupil.position.set(0.45, 0.2, 0.82);
    head.add(rightPupil);

    // Ears
    leftEar = box(0.25, 0.6, 0.15, brightOrange);
    leftEar.position.set(-0.5, 0.9, -0.2);
    leftEar.rotation.z = 0.3;
    head.add(leftEar);

    rightEar = box(0.25, 0.6, 0.15, brightOrange);
    rightEar.position.set(0.5, 0.9, -0.2);
    rightEar.rotation.z = -0.3;
    head.add(rightEar);

    // Mouth
    mouth = box(0.5, 0.15, 0.1, black);
    mouth.position.set(0, -0.7, 1.5);
    mouth.visible = false;
    head.add(mouth);

    head.position.set(0, 6.2, 2.2);
    head.rotation.x = 0.2;
    character.add(head);

    // Mane flames (along neck and head)
    var manePositions = [
      { x: 0, y: 7.2, z: 1.8, s: 1.2 },
      { x: 0, y: 6.8, z: 1.5, s: 1.0 },
      { x: 0, y: 6.3, z: 1.2, s: 0.9 },
      { x: 0, y: 5.8, z: 0.9, s: 0.8 },
      { x: 0, y: 5.3, z: 0.6, s: 0.7 },
      { x: 0, y: 4.8, z: 0.3, s: 0.6 },
    ];

    manePositions.forEach(function (pos) {
      // Core flame
      var f1 = flame(0.3 * pos.s, 0.8 * pos.s, 0.3 * pos.s);
      f1.position.set(pos.x, pos.y, pos.z);
      character.add(f1);
      maneFlames.push(f1);

      // Side flames
      var f2 = flame(0.2 * pos.s, 0.6 * pos.s, 0.2 * pos.s);
      f2.position.set(pos.x - 0.2, pos.y - 0.1, pos.z);
      character.add(f2);
      maneFlames.push(f2);

      var f3 = flame(0.2 * pos.s, 0.6 * pos.s, 0.2 * pos.s);
      f3.position.set(pos.x + 0.2, pos.y - 0.1, pos.z);
      character.add(f3);
      maneFlames.push(f3);
    });

    // Tail flames
    var tailBase = box(0.4, 0.4, 1.0, brightOrange);
    tailBase.position.set(0, 3.5, -2.2);
    tailBase.rotation.x = 0.5;
    character.add(tailBase);

    for (var i = 0; i < 5; i++) {
      var tf = flame(0.3 - i * 0.03, 0.5 + i * 0.15, 0.3 - i * 0.03);
      tf.position.set(0, 3.2 - i * 0.3, -2.8 - i * 0.4);
      character.add(tf);
      tailFlames.push(tf);
    }

    // Laptop (for working state)
    var laptopBase = box(2.8, 0.15, 1.8, 0x1f2937);
    laptopBase.position.set(0, 0.3, 4.5);
    character.add(laptopBase);

    var laptopScreen = box(2.6, 1.8, 0.1, 0x111827);
    laptopScreen.position.set(0, 1.4, 5.5);
    laptopScreen.rotation.x = 0.3;
    character.add(laptopScreen);

    var laptopDisplay = box(2.3, 1.5, 0.02, 0x0ea5e9, 0x0ea5e9);
    laptopDisplay.position.set(0, 1.4, 5.44);
    laptopDisplay.rotation.x = 0.3;
    character.add(laptopDisplay);

    var codeLine1 = box(1.8, 0.08, 0.01, 0xff6600, 0xff6600);
    codeLine1.position.set(-0.2, 1.7, 5.4);
    codeLine1.rotation.x = 0.3;
    character.add(codeLine1);

    var codeLine2 = box(1.4, 0.08, 0.01, 0xfbbf24, 0xfbbf24);
    codeLine2.position.set(0, 1.5, 5.4);
    codeLine2.rotation.x = 0.3;
    character.add(codeLine2);

    var codeLine3 = box(2.0, 0.08, 0.01, 0xff3300, 0xff3300);
    codeLine3.position.set(0.1, 1.3, 5.4);
    codeLine3.rotation.x = 0.3;
    character.add(codeLine3);

    window._laptopParts = [
      laptopBase,
      laptopScreen,
      laptopDisplay,
      codeLine1,
      codeLine2,
      codeLine3,
    ];
    window._laptopParts.forEach(function (p) {
      p.visible = false;
    });
  }

  var originalColors = {};
  function storeOriginalColors() {
    if (!character) return;
    character.traverse(function (child) {
      if (child.isMesh && child.material) {
        originalColors[child.uuid] = child.material.color.getHex();
      }
    });
  }

  function setGrayscale(enable) {
    if (!character) return;
    character.traverse(function (child) {
      if (child.isMesh && child.material && originalColors[child.uuid] !== undefined) {
        if (enable) {
          var c = new THREE.Color(originalColors[child.uuid]);
          var gray = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
          child.material.color.setRGB(gray, gray, gray);
          if (child.material.emissive) {
            child.material.emissiveIntensity = 0;
          }
        } else {
          child.material.color.setHex(originalColors[child.uuid]);
          if (child.material.emissive) {
            child.material.emissiveIntensity = 0.5;
          }
        }
      }
    });
  }

  function animate() {
    requestAnimationFrame(animate);
    var delta = clock.getDelta();
    var elapsed = clock.getElapsedTime();

    // Connection color
    connCurrent.r += (connTarget.r - connCurrent.r) * 0.05;
    connCurrent.g += (connTarget.g - connCurrent.g) * 0.05;
    connCurrent.b += (connTarget.b - connCurrent.b) * 0.05;
    if (statusRingMat) statusRingMat.color.setRGB(connCurrent.r, connCurrent.g, connCurrent.b);
    if (outerGlowMat) outerGlowMat.color.setRGB(connCurrent.r, connCurrent.g, connCurrent.b);

    // Auto-transition thinking -> working
    if (currentState === "thinking") {
      var thinkingDuration = Date.now() - thinkingStartTime;
      if (thinkingDuration > workingTransitionMs) {
        currentState = "working";
      }
    }

    // Animate flames (always)
    var flameIntensity =
      currentState === "happy" || currentState === "celebrating"
        ? 2.0
        : currentState === "error"
          ? 1.5
          : currentState === "sleeping"
            ? 0.3
            : 1.0;

    maneFlames.forEach(function (f, i) {
      f.scale.y = 1 + Math.sin(elapsed * 8 + i * 0.5) * 0.3 * flameIntensity;
      f.scale.x = 1 + Math.sin(elapsed * 6 + i * 0.3) * 0.2 * flameIntensity;
      f.position.y += Math.sin(elapsed * 10 + i) * 0.01 * flameIntensity;

      // Color shift
      var hue = (Math.sin(elapsed * 3 + i * 0.2) + 1) / 2;
      var r = 1;
      var g = 0.3 + hue * 0.5;
      var b = hue * 0.2;
      f.material.color.setRGB(r, g, b);
    });

    tailFlames.forEach(function (f, i) {
      f.scale.y = 1 + Math.sin(elapsed * 7 + i * 0.7) * 0.4 * flameIntensity;
      f.rotation.x = Math.sin(elapsed * 5 + i) * 0.2;

      var hue = (Math.sin(elapsed * 4 + i * 0.3) + 1) / 2;
      f.material.color.setRGB(1, 0.3 + hue * 0.4, hue * 0.15);
    });

    hoofFlames.forEach(function (f, i) {
      f.scale.y = 0.5 + Math.sin(elapsed * 10 + i * 2) * 0.3 * flameIntensity;
      f.material.opacity = 0.6 + Math.sin(elapsed * 8 + i) * 0.3;
    });

    // Fire glow pulsing
    if (window._fireGlow) {
      window._fireGlow.intensity = 1.5 + Math.sin(elapsed * 4) * 0.5 * flameIntensity;
    }

    // Reset transforms
    character.position.x = 0;
    character.position.z = 0;
    character.rotation.y = userRotationY;
    character.rotation.z = 0;
    character.rotation.x = 0;
    if (head) {
      head.rotation.z = 0;
      head.rotation.x = 0.2;
    }
    if (leftEye) leftEye.scale.set(1, 1, 1);
    if (rightEye) rightEye.scale.set(1, 1, 1);
    if (leftEar) {
      leftEar.rotation.x = 0;
    }
    if (rightEar) {
      rightEar.rotation.x = 0;
    }

    // State animations
    if (currentState === "idle") {
      character.position.y = Math.sin(elapsed * 1.5) * 0.08;
      if (head) head.rotation.y = Math.sin(elapsed * 0.5) * 0.1;
      // Breathing
      if (window._nostrils) {
        window._nostrils.forEach(function (n) {
          n.material.emissiveIntensity = 0.3 + Math.sin(elapsed * 2) * 0.2;
        });
      }
      // Ears twitch occasionally
      if (leftEar && Math.sin(elapsed * 0.3) > 0.95) {
        leftEar.rotation.x = Math.sin(elapsed * 15) * 0.2;
      }
    } else if (currentState === "thinking") {
      character.position.y = Math.sin(elapsed * 1) * 0.05;
      if (head) {
        head.rotation.z = Math.sin(elapsed * 0.8) * 0.1;
        head.rotation.x = 0.35; // Looking up
      }
      // Pupils up
      if (leftPupil) leftPupil.position.y = 0.3;
      if (rightPupil) rightPupil.position.y = 0.3;
      // Ears forward
      if (leftEar) leftEar.rotation.x = -0.3;
      if (rightEar) rightEar.rotation.x = -0.3;
    } else if (currentState === "talking") {
      character.position.y = Math.sin(elapsed * 3) * 0.1;
      character.rotation.y = userRotationY + Math.sin(elapsed * 2) * 0.08;
      if (head) head.rotation.y = Math.sin(elapsed * 4) * 0.15;
      if (mouth) {
        mouth.visible = true;
        mouth.scale.y = 0.5 + Math.abs(Math.sin(elapsed * 12)) * 1.5;
      }
      // Eyes engaged
      if (leftEye) leftEye.scale.y = 1.1;
      if (rightEye) rightEye.scale.y = 1.1;
      // Nostrils flare
      if (window._nostrils) {
        window._nostrils.forEach(function (n) {
          n.material.emissiveIntensity = 0.5 + Math.sin(elapsed * 8) * 0.3;
        });
      }
    } else if (currentState === "happy" || currentState === "celebrating") {
      character.position.y = Math.abs(Math.sin(elapsed * 5)) * 0.6;
      character.rotation.y = userRotationY + Math.sin(elapsed * 3) * 0.15;
      character.rotation.z = Math.sin(elapsed * 4) * 0.1;
      if (head) {
        head.rotation.y = Math.sin(elapsed * 6) * 0.2;
        head.position.y = 6.2 + Math.sin(elapsed * 8) * 0.2;
      }
      // Happy eyes
      if (leftEye) leftEye.scale.y = 0.7; // Squinty happy
      if (rightEye) rightEye.scale.y = 0.7;
      // Legs prance
      if (window._legs) {
        window._legs.forEach(function (leg, i) {
          leg.position.y = 0.2 + Math.abs(Math.sin(elapsed * 8 + i * 1.5)) * 0.3;
        });
      }
    } else if (currentState === "working" || currentState === "coding") {
      character.position.y = Math.sin(elapsed * 1.5) * 0.03;
      character.rotation.x = 0.15;
      character.position.z = -0.5;
      if (head) {
        head.rotation.x = 0.4; // Looking down at laptop
        head.position.y = 5.8;
      }
      // Focused eyes
      if (leftEye) leftEye.scale.y = 0.85;
      if (rightEye) rightEye.scale.y = 0.85;
      if (leftPupil) leftPupil.position.y = 0.1;
      if (rightPupil) rightPupil.position.y = 0.1;
    } else if (currentState === "sleeping") {
      character.position.y = Math.sin(elapsed * 0.5) * 0.03;
      if (head) {
        head.rotation.x = 0.5; // Head down
        head.position.y = 5.5;
      }
      // Eyes closed
      if (leftEye) leftEye.scale.y = 0.15;
      if (rightEye) rightEye.scale.y = 0.15;
      // Ears relaxed
      if (leftEar) leftEar.rotation.z = 0.5;
      if (rightEar) rightEar.rotation.z = -0.5;
    } else if (currentState === "error" || currentState === "frustrated") {
      character.position.x = Math.sin(elapsed * 20) * 0.15;
      character.position.y = 0.1;
      if (head) head.rotation.z = Math.sin(elapsed * 15) * 0.1;
      // Angry eyes
      if (leftEye) leftEye.scale.y = 0.6;
      if (rightEye) rightEye.scale.y = 0.6;
      // Ears back
      if (leftEar) leftEar.rotation.x = 0.5;
      if (rightEar) rightEar.rotation.x = 0.5;
      // Nostrils flare intensely
      if (window._nostrils) {
        window._nostrils.forEach(function (n) {
          n.material.emissiveIntensity = 0.8 + Math.sin(elapsed * 10) * 0.2;
        });
      }
    } else if (currentState === "listening") {
      character.position.y = 0.3 + Math.sin(elapsed * 2) * 0.1;
      character.position.z = 0.5;
      character.rotation.x = -0.1;
      if (head) {
        head.rotation.x = 0.1;
        head.rotation.y = Math.sin(elapsed * 1) * 0.1;
      }
      // Big attentive eyes
      if (leftEye) leftEye.scale.set(1.2, 1.25, 1);
      if (rightEye) rightEye.scale.set(1.2, 1.25, 1);
      // Ears very forward
      if (leftEar) leftEar.rotation.x = -0.5;
      if (rightEar) rightEar.rotation.x = -0.5;
    }

    // Hide mouth when not talking
    if (currentState !== "talking" && mouth) {
      mouth.visible = false;
      mouth.scale.y = 1;
    }

    renderer.render(scene, camera);
  }

  window.setAvatarState = function (state) {
    if (state === "thinking") {
      thinkingStartTime = Date.now();
    }
    currentState = state;

    var showLaptop = state === "working" || state === "coding";
    if (window._laptopParts) {
      window._laptopParts.forEach(function (part) {
        part.visible = showLaptop;
      });
    }

    if (state === "error" && avatarFlash) {
      avatarFlash.classList.add("active");
      setTimeout(function () {
        avatarFlash.classList.remove("active");
      }, 300);
    }
  };

  window.setAvatarConnection = function (state) {
    connectionState = state;
    if (state === "online" || state === "connecting") {
      connTarget = getAccentRGB();
    } else if (state === "offline") {
      connTarget = getDimAccent();
    }
    if (platformMat) {
      if (state === "online") {
        platformMat.color.setHex(0x22c55e);
        platformMat.opacity = 0.15;
      } else if (state === "connecting") {
        platformMat.color.setHex(0xf59e0b);
        platformMat.opacity = 0.12;
      } else if (state === "reconnecting") {
        platformMat.color.setHex(0xf59e0b);
        platformMat.opacity = 0.1;
      } else {
        platformMat.color.setHex(0xef4444);
        platformMat.opacity = 0.08;
      }
    }
    setGrayscale(state === "offline" || state === "reconnecting");
  };

  window.adjustAvatarCamera = function () {
    if (!camera || !renderer) return;
    var container = document.getElementById("avatarCanvas");
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
