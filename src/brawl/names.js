// Callsigns handed out to players who have not typed a name yet (3-8 letters each), so the
// entry card never stops anyone at an empty field.
var CALLSIGNS = `Viper Falcon Raven Ghost Cobra Hawk Wolf Tiger Shadow Storm Blaze Ranger Nomad Rogue Saber Comet Titan
Phantom Echo Delta Omega Alpha Bravo Kilo Zulu Maverick Striker Hunter Sniper Reaper Spartan Anvil Bishop Cinder Dagger
Ember Flint Gryphon Harrier Iron Jackal Kestrel Lynx Mamba Nova Onyx Pike Quartz Rook Spectre Talon Umbra Vector Warden
Xenon Yeti Zephyr Arrow Bolt Crow Drift Edge Fox Grit Havoc Ion Jolt Knight Laser Mirage Nitro Orca Pulse Quake Radar
Scout Thorn Venom Wraith Apex Basalt Cyclone Dusk Eagle Frost Gale Hornet Ivory Jaguar Karma Lancer Mustang Nimbus
Osprey Panther Raptor Sabre Tundra Bandit Corsair`.split(/\s+/);

function randomCallsign(random = Math.random) {
  return CALLSIGNS[Math.floor(random() * CALLSIGNS.length) % CALLSIGNS.length];
}

export { CALLSIGNS, randomCallsign };
