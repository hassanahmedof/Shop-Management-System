import type { Brand, Category } from '../types/shop';
import { DEFAULT_PRODUCT_CATEGORIES, normalizeCategoryKey } from './packaging';

export interface DefaultBrandDefinition {
  id: string;
  name: string;
  categoryIds: string[];
}

export const DEFAULT_PRODUCT_BRANDS: DefaultBrandDefinition[] = [
  // Diapers & Pampers, Baby Wipes & Multi-category Baby Brands
  { id: 'brand_pampers', name: 'Pampers', categoryIds: ['cat_diapers', 'cat_wipes'] },
  { id: 'brand_molfix', name: 'Molfix', categoryIds: ['cat_diapers', 'cat_wipes'] },
  { id: 'brand_huggies', name: 'Huggies', categoryIds: ['cat_diapers', 'cat_wipes'] },
  { id: 'brand_canbebe', name: 'Canbebe', categoryIds: ['cat_diapers', 'cat_wipes'] },
  { id: 'brand_bonapapa', name: 'Bona Papa', categoryIds: ['cat_diapers', 'cat_wipes'] },
  { id: 'brand_shield', name: 'Shield', categoryIds: ['cat_baby_care', 'cat_diapers', 'cat_wipes', 'cat_personal_care'] },
  { id: 'brand_momse', name: 'Momse', categoryIds: ['cat_diapers', 'cat_wipes'] },
  { id: 'brand_susu', name: 'Susu', categoryIds: ['cat_diapers'] },
  { id: 'brand_leo', name: 'Leo', categoryIds: ['cat_diapers', 'cat_wipes'] },
  { id: 'brand_carebaby', name: 'Care Baby', categoryIds: ['cat_diapers', 'cat_wipes', 'cat_baby_care'] },
  { id: 'brand_coolandcool', name: 'Cool & Cool', categoryIds: ['cat_wipes', 'cat_baby_care', 'cat_hygiene', 'cat_personal_care', 'cat_tissues'] },
  { id: 'brand_bebem', name: 'Bebem Natural', categoryIds: ['cat_diapers', 'cat_wipes'] },
  { id: 'brand_mamypoko', name: 'MamyPoko', categoryIds: ['cat_diapers', 'cat_wipes'] },
  { id: 'brand_cuddles', name: 'Cuddles', categoryIds: ['cat_diapers', 'cat_wipes'] },
  { id: 'brand_prima', name: 'Prima', categoryIds: ['cat_diapers'] },
  { id: 'brand_evybaby', name: 'Evy Baby', categoryIds: ['cat_diapers', 'cat_wipes'] },
  { id: 'brand_puffin', name: 'Puffin', categoryIds: ['cat_diapers'] },
  { id: 'brand_bambino', name: 'Bambino', categoryIds: ['cat_diapers', 'cat_baby_care'] },
  { id: 'brand_libero', name: 'Libero', categoryIds: ['cat_diapers'] },
  { id: 'brand_finebaby', name: 'Fine Baby', categoryIds: ['cat_diapers', 'cat_wipes'] },
  { id: 'brand_sleepy', name: 'Sleepy', categoryIds: ['cat_diapers', 'cat_wipes', 'cat_hygiene'] },
  { id: 'brand_comfy', name: 'Comfy', categoryIds: ['cat_diapers', 'cat_hygiene'] },
  { id: 'brand_freshup', name: 'Fresh Up', categoryIds: ['cat_wipes', 'cat_tissues'] },

  // Baby Care, Baby Formula & Infant Nutrition
  { id: 'brand_johnsons', name: "Johnson's", categoryIds: ['cat_baby_care', 'cat_wipes', 'cat_personal_care'] },
  { id: 'brand_nexton', name: 'Nexton', categoryIds: ['cat_baby_care', 'cat_wipes'] },
  { id: 'brand_pigeon', name: 'Pigeon', categoryIds: ['cat_baby_care', 'cat_wipes'] },
  { id: 'brand_mothercare', name: 'Mothercare', categoryIds: ['cat_baby_care', 'cat_wipes'] },
  { id: 'brand_sebamed', name: 'Sebamed', categoryIds: ['cat_baby_care', 'cat_personal_care'] },
  { id: 'brand_chicco', name: 'Chicco', categoryIds: ['cat_baby_care', 'cat_wipes'] },
  { id: 'brand_sudocrem', name: 'Sudocrem', categoryIds: ['cat_baby_care'] },
  { id: 'brand_mustela', name: 'Mustela', categoryIds: ['cat_baby_care'] },
  { id: 'brand_aveeno', name: 'Aveeno', categoryIds: ['cat_baby_care', 'cat_personal_care'] },
  { id: 'brand_cetaphil', name: 'Cetaphil', categoryIds: ['cat_baby_care', 'cat_personal_care'] },
  { id: 'brand_farlin', name: 'Farlin', categoryIds: ['cat_baby_care'] },
  { id: 'brand_avent', name: 'Philips Avent', categoryIds: ['cat_baby_care'] },
  { id: 'brand_pureen', name: 'Pureen', categoryIds: ['cat_baby_care', 'cat_wipes'] },
  { id: 'brand_cerelac', name: 'Cerelac', categoryIds: ['cat_baby_care'] },
  { id: 'brand_lactogen', name: 'Lactogen', categoryIds: ['cat_baby_care'] },
  { id: 'brand_nan', name: 'NAN', categoryIds: ['cat_baby_care'] },
  { id: 'brand_nido', name: 'Nido', categoryIds: ['cat_baby_care', 'cat_water_juices', 'cat_other'] },
  { id: 'brand_morinaga', name: 'Morinaga', categoryIds: ['cat_baby_care'] },
  { id: 'brand_similac', name: 'Similac', categoryIds: ['cat_baby_care'] },
  { id: 'brand_pediasure', name: 'PediaSure', categoryIds: ['cat_baby_care'] },
  { id: 'brand_aptamil', name: 'Aptamil', categoryIds: ['cat_baby_care'] },
  { id: 'brand_enfagrow', name: 'Enfagrow', categoryIds: ['cat_baby_care'] },
  { id: 'brand_cowandgate', name: 'Cow & Gate', categoryIds: ['cat_baby_care'] },

  // Personal Care & Toiletries & Hygiene
  { id: 'brand_dove', name: 'Dove', categoryIds: ['cat_personal_care', 'cat_baby_care'] },
  { id: 'brand_lux', name: 'Lux', categoryIds: ['cat_personal_care'] },
  { id: 'brand_lifebuoy', name: 'Lifebuoy', categoryIds: ['cat_personal_care', 'cat_hygiene'] },
  { id: 'brand_dettol', name: 'Dettol', categoryIds: ['cat_hygiene', 'cat_personal_care', 'cat_household_cleaning'] },
  { id: 'brand_nivea', name: 'Nivea', categoryIds: ['cat_personal_care'] },
  { id: 'brand_sunsilk', name: 'Sunsilk', categoryIds: ['cat_personal_care'] },
  { id: 'brand_pantene', name: 'Pantene', categoryIds: ['cat_personal_care'] },
  { id: 'brand_headandshoulders', name: 'Head & Shoulders', categoryIds: ['cat_personal_care'] },
  { id: 'brand_colgate', name: 'Colgate', categoryIds: ['cat_personal_care'] },
  { id: 'brand_oralb', name: 'Oral-B', categoryIds: ['cat_personal_care'] },
  { id: 'brand_safeguard', name: 'Safeguard', categoryIds: ['cat_personal_care', 'cat_hygiene'] },
  { id: 'brand_capri', name: 'Capri', categoryIds: ['cat_personal_care'] },
  { id: 'brand_palmolive', name: 'Palmolive', categoryIds: ['cat_personal_care'] },
  { id: 'brand_clear', name: 'Clear', categoryIds: ['cat_personal_care'] },
  { id: 'brand_tresemme', name: 'Tresemmé', categoryIds: ['cat_personal_care'] },
  { id: 'brand_loreal', name: "L'Oréal", categoryIds: ['cat_personal_care'] },
  { id: 'brand_garnier', name: 'Garnier', categoryIds: ['cat_personal_care'] },
  { id: 'brand_vaseline', name: 'Vaseline', categoryIds: ['cat_personal_care', 'cat_baby_care'] },
  { id: 'brand_ponds', name: "Pond's", categoryIds: ['cat_personal_care'] },
  { id: 'brand_glowandlovely', name: 'Glow & Lovely', categoryIds: ['cat_personal_care'] },
  { id: 'brand_sensodyne', name: 'Sensodyne', categoryIds: ['cat_personal_care'] },
  { id: 'brand_closeup', name: 'Close-Up', categoryIds: ['cat_personal_care'] },
  { id: 'brand_pepsodent', name: 'Pepsodent', categoryIds: ['cat_personal_care'] },
  { id: 'brand_medicam', name: 'Medicam', categoryIds: ['cat_personal_care'] },
  { id: 'brand_listerine', name: 'Listerine', categoryIds: ['cat_personal_care', 'cat_hygiene'] },
  { id: 'brand_saeedghani', name: 'Saeed Ghani', categoryIds: ['cat_personal_care'] },
  { id: 'brand_hemani', name: 'Hemani', categoryIds: ['cat_personal_care', 'cat_other'] },
  { id: 'brand_tibet', name: 'Tibet', categoryIds: ['cat_personal_care'] },
  { id: 'brand_vatika', name: 'Vatika', categoryIds: ['cat_personal_care'] },
  { id: 'brand_dabur_amla', name: 'Dabur Amla', categoryIds: ['cat_personal_care'] },
  { id: 'brand_parachute', name: 'Parachute', categoryIds: ['cat_personal_care'] },
  { id: 'brand_rexona', name: 'Rexona', categoryIds: ['cat_personal_care'] },
  { id: 'brand_fogg', name: 'Fogg', categoryIds: ['cat_personal_care'] },
  { id: 'brand_axe', name: 'Axe', categoryIds: ['cat_personal_care'] },
  { id: 'brand_fa', name: 'Fa', categoryIds: ['cat_personal_care'] },
  { id: 'brand_oldspice', name: 'Old Spice', categoryIds: ['cat_personal_care'] },
  { id: 'brand_gillette', name: 'Gillette', categoryIds: ['cat_personal_care'] },
  { id: 'brand_treet', name: 'Treet', categoryIds: ['cat_personal_care'] },
  { id: 'brand_schick', name: 'Schick', categoryIds: ['cat_personal_care'] },
  { id: 'brand_veet', name: 'Veet', categoryIds: ['cat_personal_care'] },
  { id: 'brand_himalaya', name: 'Himalaya', categoryIds: ['cat_personal_care', 'cat_baby_care'] },
  { id: 'brand_carmex', name: 'Carmex', categoryIds: ['cat_personal_care'] },
  { id: 'brand_labello', name: 'Labello', categoryIds: ['cat_personal_care'] },
  { id: 'brand_maybelline', name: 'Maybelline', categoryIds: ['cat_personal_care'] },
  { id: 'brand_burtsbees', name: "Burt's Bees", categoryIds: ['cat_personal_care'] },
  { id: 'brand_lipice', name: 'Lip Ice', categoryIds: ['cat_personal_care'] },
  { id: 'brand_bioaqua', name: 'BIOAQUA', categoryIds: ['cat_personal_care'] },
  { id: 'brand_sadoer', name: 'SADOER', categoryIds: ['cat_personal_care'] },
  { id: 'brand_neutrogena', name: 'Neutrogena', categoryIds: ['cat_personal_care'] },
  { id: 'brand_cerave', name: 'CeraVe', categoryIds: ['cat_personal_care'] },
  { id: 'brand_simple', name: 'Simple', categoryIds: ['cat_personal_care'] },
  { id: 'brand_stives', name: 'St. Ives', categoryIds: ['cat_personal_care'] },
  { id: 'brand_conatural', name: 'Conatural', categoryIds: ['cat_personal_care'] },
  { id: 'brand_blistex', name: 'Blistex', categoryIds: ['cat_personal_care'] },
  { id: 'brand_chapstick', name: 'ChapStick', categoryIds: ['cat_personal_care'] },
  { id: 'brand_olivia', name: 'Olivia', categoryIds: ['cat_personal_care'] },
  { id: 'brand_care', name: 'Care', categoryIds: ['cat_personal_care', 'cat_baby_care'] },
  { id: 'brand_drrashel', name: 'Dr. Rashel', categoryIds: ['cat_personal_care'] },
  { id: 'brand_goldenpearl', name: 'Golden Pearl', categoryIds: ['cat_personal_care'] },
  { id: 'brand_stillmans', name: "Stillman's", categoryIds: ['cat_personal_care'] },
  { id: 'brand_pears', name: 'Pears', categoryIds: ['cat_personal_care'] },
  { id: 'brand_imperialleather', name: 'Imperial Leather', categoryIds: ['cat_personal_care'] },
  { id: 'brand_enchanteur', name: 'Enchanteur', categoryIds: ['cat_personal_care'] },
  { id: 'brand_yardley', name: 'Yardley', categoryIds: ['cat_personal_care'] },
  { id: 'brand_always', name: 'Always', categoryIds: ['cat_hygiene'] },
  { id: 'brand_stayfree', name: 'Stayfree', categoryIds: ['cat_hygiene'] },
  { id: 'brand_butterfly', name: 'Butterfly', categoryIds: ['cat_hygiene'] },
  { id: 'brand_whisper', name: 'Whisper', categoryIds: ['cat_hygiene'] },
  { id: 'brand_kotex', name: 'Kotex', categoryIds: ['cat_hygiene'] },
  { id: 'brand_carefree', name: 'Carefree', categoryIds: ['cat_hygiene'] },
  { id: 'brand_mothercomfort', name: 'Mother Comfort', categoryIds: ['cat_hygiene'] },
  { id: 'brand_confidence', name: 'Confidence', categoryIds: ['cat_hygiene'] },
  { id: 'brand_tena', name: 'Tena', categoryIds: ['cat_hygiene'] },
  { id: 'brand_sanicare', name: 'Sanicare', categoryIds: ['cat_hygiene', 'cat_wipes'] },

  // Sexual Wellness (Condoms, Lubricants & Intimate Care)
  { id: 'brand_durex', name: 'Durex', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_josh', name: 'Josh', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_touch', name: 'Touch', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_sathi', name: 'Sathi / Saathi', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_do', name: 'DO', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_pulse', name: 'Pulse', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_happylife', name: 'Happy Life', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_klimax', name: 'Klimax', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_knightrider', name: 'Knight Rider', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_amore', name: 'Amore', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_amor', name: 'Amor', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_pasante', name: 'Pasante', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_skyn', name: 'Skyn', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_trojan', name: 'Trojan', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_eros', name: 'Eros', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_contempo', name: 'Contempo', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_simplex', name: 'Simplex', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_roughrider', name: 'Rough Rider', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_xtacy', name: 'Xtacy', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_ok', name: 'OK', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_excite', name: 'Excite', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_libido', name: 'Libido', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_viga', name: 'Viga', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_carex', name: 'Carex', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_coronet', name: 'Coronet', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_play', name: 'Play', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_ky', name: 'KY', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_manforce', name: 'Manforce', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_moods', name: 'Moods', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_kohinoor', name: 'Kohinoor', categoryIds: ['cat_sexual_wellness'] },
  { id: 'brand_kamasutra', name: 'KamaSutra', categoryIds: ['cat_sexual_wellness'] },

  // Tissue & Paper Products
  { id: 'brand_rosepetal', name: 'Rose Petal', categoryIds: ['cat_tissues', 'cat_wipes', 'cat_hygiene'] },
  { id: 'brand_fay', name: 'Fay', categoryIds: ['cat_tissues'] },
  { id: 'brand_tulip', name: 'Tulip', categoryIds: ['cat_tissues'] },
  { id: 'brand_fine', name: 'Fine', categoryIds: ['cat_tissues', 'cat_hygiene', 'cat_baby_care'] },
  { id: 'brand_kleenex', name: 'Kleenex', categoryIds: ['cat_tissues', 'cat_wipes'] },
  { id: 'brand_pearl', name: 'Pearl', categoryIds: ['cat_tissues'] },
  { id: 'brand_maxob', name: 'Maxob', categoryIds: ['cat_tissues'] },
  { id: 'brand_flora', name: 'Flora', categoryIds: ['cat_tissues'] },

  // Household Cleaning
  { id: 'brand_surfexcel', name: 'Surf Excel', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_ariel', name: 'Ariel', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_tide', name: 'Tide', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_harpic', name: 'Harpic', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_vim', name: 'Vim', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_brite', name: 'Brite', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_bonus', name: 'Bonus', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_expresspower', name: 'Express Power', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_lemonmax', name: 'Lemon Max', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_max', name: 'Max', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_sunlight', name: 'Sunlight', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_comfort', name: 'Comfort', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_sufi', name: 'Sufi', categoryIds: ['cat_household_cleaning', 'cat_other'] },
  { id: 'brand_robin', name: 'Robin', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_mortein', name: 'Mortein', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_kingtox', name: 'Kingtox', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_cobra', name: 'Cobra', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_finis', name: 'Finis', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_glint', name: 'Glint', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_mrmuscle', name: 'Mr. Muscle', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_scotchbrite', name: 'Scotch-Brite', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_domex', name: 'Domex', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_vanish', name: 'Vanish', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_airwick', name: 'Air Wick', categoryIds: ['cat_household_cleaning'] },
  { id: 'brand_glade', name: 'Glade', categoryIds: ['cat_household_cleaning'] },

  // Cold Drinks, Tea/Coffee, Water & Juices
  { id: 'brand_pepsi', name: 'Pepsi', categoryIds: ['cat_cold_drinks'] },
  { id: 'brand_cocacola', name: 'Coca-Cola', categoryIds: ['cat_cold_drinks'] },
  { id: 'brand_pakola', name: 'Pakola', categoryIds: ['cat_cold_drinks', 'cat_water_juices'] },
  { id: 'brand_colanext', name: 'Cola Next', categoryIds: ['cat_cold_drinks'] },
  { id: 'brand_fizzup', name: 'Fizzup', categoryIds: ['cat_cold_drinks'] },
  { id: 'brand_7up', name: '7UP', categoryIds: ['cat_cold_drinks'] },
  { id: 'brand_sprite', name: 'Sprite', categoryIds: ['cat_cold_drinks'] },
  { id: 'brand_sting', name: 'Sting', categoryIds: ['cat_cold_drinks'] },
  { id: 'brand_mountaindew', name: 'Mountain Dew', categoryIds: ['cat_cold_drinks'] },
  { id: 'brand_mirinda', name: 'Mirinda', categoryIds: ['cat_cold_drinks'] },
  { id: 'brand_fanta', name: 'Fanta', categoryIds: ['cat_cold_drinks'] },
  { id: 'brand_gourmet', name: 'Gourmet', categoryIds: ['cat_cold_drinks', 'cat_water_juices', 'cat_snacks'] },
  { id: 'brand_redbull', name: 'Red Bull', categoryIds: ['cat_cold_drinks'] },
  { id: 'brand_monster', name: 'Monster', categoryIds: ['cat_cold_drinks'] },
  { id: 'brand_barbican', name: 'Barbican', categoryIds: ['cat_cold_drinks'] },
  { id: 'brand_rani', name: 'Rani', categoryIds: ['cat_water_juices', 'cat_cold_drinks'] },
  { id: 'brand_roohafza', name: 'Rooh Afza', categoryIds: ['cat_cold_drinks', 'cat_water_juices'] },
  { id: 'brand_jame_shirin', name: 'Jam-e-Shirin', categoryIds: ['cat_cold_drinks', 'cat_water_juices'] },
  { id: 'brand_lipton', name: 'Lipton', categoryIds: ['cat_cold_drinks', 'cat_other'] },
  { id: 'brand_tapal', name: 'Tapal', categoryIds: ['cat_cold_drinks', 'cat_other'] },
  { id: 'brand_brookebond', name: 'Brooke Bond', categoryIds: ['cat_cold_drinks', 'cat_other'] },
  { id: 'brand_vitaltea', name: 'Vital Tea', categoryIds: ['cat_cold_drinks', 'cat_other'] },
  { id: 'brand_kashmirtea', name: 'Kashmir Tea', categoryIds: ['cat_cold_drinks', 'cat_other'] },
  { id: 'brand_everyday', name: 'Everyday', categoryIds: ['cat_cold_drinks', 'cat_other'] },
  { id: 'brand_tarang', name: 'Tarang', categoryIds: ['cat_water_juices', 'cat_cold_drinks', 'cat_other'] },
  { id: 'brand_nescafe', name: 'Nescafé', categoryIds: ['cat_cold_drinks', 'cat_other'] },
  { id: 'brand_nestle', name: 'Nestlé', categoryIds: ['cat_water_juices', 'cat_cold_drinks', 'cat_baby_care', 'cat_snacks', 'cat_other'] },
  { id: 'brand_fruitavitals', name: 'Fruita Vitals', categoryIds: ['cat_water_juices'] },
  { id: 'brand_nesfruta', name: 'Nesfruta', categoryIds: ['cat_water_juices'] },
  { id: 'brand_aquafina', name: 'Aquafina', categoryIds: ['cat_water_juices'] },
  { id: 'brand_dasani', name: 'Dasani', categoryIds: ['cat_water_juices'] },
  { id: 'brand_olpers', name: "Olper's", categoryIds: ['cat_water_juices', 'cat_cold_drinks', 'cat_other'] },
  { id: 'brand_milkpak', name: 'Milkpak', categoryIds: ['cat_water_juices', 'cat_cold_drinks', 'cat_other'] },
  { id: 'brand_nurpur', name: 'Nurpur', categoryIds: ['cat_water_juices', 'cat_other'] },
  { id: 'brand_haleeb', name: 'Haleeb', categoryIds: ['cat_water_juices', 'cat_other'] },
  { id: 'brand_dayfresh', name: 'Dayfresh', categoryIds: ['cat_water_juices'] },
  { id: 'brand_prema', name: 'Prema', categoryIds: ['cat_water_juices'] },
  { id: 'brand_adams', name: "Adam's", categoryIds: ['cat_water_juices', 'cat_other'] },
  { id: 'brand_slice', name: 'Slice', categoryIds: ['cat_water_juices'] },
  { id: 'brand_shezan', name: 'Shezan', categoryIds: ['cat_water_juices', 'cat_cold_drinks', 'cat_other'] },
  { id: 'brand_milo', name: 'Milo', categoryIds: ['cat_water_juices', 'cat_cold_drinks', 'cat_snacks'] },
  { id: 'brand_cappy', name: 'Cappy', categoryIds: ['cat_water_juices'] },
  { id: 'brand_tang', name: 'Tang', categoryIds: ['cat_water_juices', 'cat_cold_drinks'] },
  { id: 'brand_quice', name: 'Quice', categoryIds: ['cat_water_juices', 'cat_cold_drinks'] },
  { id: 'brand_tops', name: 'Tops', categoryIds: ['cat_water_juices', 'cat_other'] },
  { id: 'brand_maza', name: 'Maza', categoryIds: ['cat_water_juices'] },

  // Snacks, Confectionery & Grocery Staples
  { id: 'brand_lays', name: 'Lays', categoryIds: ['cat_snacks'] },
  { id: 'brand_kurkure', name: 'Kurkure', categoryIds: ['cat_snacks'] },
  { id: 'brand_bisconni', name: 'Bisconni', categoryIds: ['cat_snacks'] },
  { id: 'brand_lu', name: 'LU', categoryIds: ['cat_snacks'] },
  { id: 'brand_cadbury', name: 'Cadbury', categoryIds: ['cat_snacks'] },
  { id: 'brand_mayfair', name: 'Mayfair', categoryIds: ['cat_snacks'] },
  { id: 'brand_peekfreans', name: 'Peek Freans', categoryIds: ['cat_snacks'] },
  { id: 'brand_kolson', name: 'Kolson', categoryIds: ['cat_snacks', 'cat_other'] },
  { id: 'brand_oreo', name: 'Oreo', categoryIds: ['cat_snacks'] },
  { id: 'brand_prince', name: 'Prince', categoryIds: ['cat_snacks'] },
  { id: 'brand_sooper', name: 'Sooper', categoryIds: ['cat_snacks'] },
  { id: 'brand_tuc', name: 'TUC', categoryIds: ['cat_snacks'] },
  { id: 'brand_wheatable', name: 'Wheatable', categoryIds: ['cat_snacks'] },
  { id: 'brand_cheetos', name: 'Cheetos', categoryIds: ['cat_snacks'] },
  { id: 'brand_slanty', name: 'Slanty', categoryIds: ['cat_snacks'] },
  { id: 'brand_supercrisp', name: 'Super Crisp', categoryIds: ['cat_snacks'] },
  { id: 'brand_kitkat', name: 'KitKat', categoryIds: ['cat_snacks'] },
  { id: 'brand_candyland', name: 'Candyland', categoryIds: ['cat_snacks'] },
  { id: 'brand_hilal', name: 'Hilal', categoryIds: ['cat_snacks'] },
  { id: 'brand_pringles', name: 'Pringles', categoryIds: ['cat_snacks'] },
  { id: 'brand_doritos', name: 'Doritos', categoryIds: ['cat_snacks'] },
  { id: 'brand_mars', name: 'Mars', categoryIds: ['cat_snacks'] },
  { id: 'brand_snickers', name: 'Snickers', categoryIds: ['cat_snacks'] },
  { id: 'brand_ferrero', name: 'Ferrero', categoryIds: ['cat_snacks'] },
  { id: 'brand_nutella', name: 'Nutella', categoryIds: ['cat_snacks', 'cat_other'] },
  { id: 'brand_indomie', name: 'Indomie', categoryIds: ['cat_snacks', 'cat_other'] },
  { id: 'brand_maggi', name: 'Maggi', categoryIds: ['cat_snacks', 'cat_other'] },
  { id: 'brand_bakeparlor', name: 'Bake Parlor', categoryIds: ['cat_snacks', 'cat_other'] },
  { id: 'brand_national', name: 'National', categoryIds: ['cat_other', 'cat_snacks'] },
  { id: 'brand_shan', name: 'Shan', categoryIds: ['cat_other', 'cat_snacks'] },
  { id: 'brand_knorr', name: 'Knorr', categoryIds: ['cat_snacks', 'cat_other'] },
  { id: 'brand_laziza', name: 'Laziza', categoryIds: ['cat_other'] },
  { id: 'brand_ahmedfoods', name: 'Ahmed Foods', categoryIds: ['cat_other'] },
  { id: 'brand_dalda', name: 'Dalda', categoryIds: ['cat_other'] },
  { id: 'brand_mezan', name: 'Mezan', categoryIds: ['cat_other', 'cat_cold_drinks'] },
  { id: 'brand_habib', name: 'Habib', categoryIds: ['cat_other'] },
  { id: 'brand_kisan', name: 'Kisan', categoryIds: ['cat_other'] },
  { id: 'brand_soyasupreme', name: 'Soya Supreme', categoryIds: ['cat_other'] },
  { id: 'brand_kashmiroil', name: 'Kashmir', categoryIds: ['cat_other'] },
  { id: 'brand_tullo', name: 'Tullo', categoryIds: ['cat_other'] },
  { id: 'brand_blueband', name: 'Blue Band', categoryIds: ['cat_other'] },
  { id: 'brand_rafhan', name: 'Rafhan', categoryIds: ['cat_other', 'cat_snacks'] },
  { id: 'brand_mitchells', name: "Mitchell's", categoryIds: ['cat_water_juices', 'cat_snacks', 'cat_other'] },
  { id: 'brand_kns', name: "K&N's", categoryIds: ['cat_other'] },
  { id: 'brand_youngs', name: "Young's", categoryIds: ['cat_other'] },
  { id: 'brand_guard', name: 'Guard', categoryIds: ['cat_other'] },
  { id: 'brand_falak', name: 'Falak', categoryIds: ['cat_other'] },
  { id: 'brand_energizer', name: 'Energizer', categoryIds: ['cat_other'] },
  { id: 'brand_duracell', name: 'Duracell', categoryIds: ['cat_other'] },
];

/**
 * Strips accents, apostrophes, hyphens, and normalizes `&` to `and`
 * so spelling variations like "Coca Cola", "Coca-Cola", "Johnson's", "Johnsons" match reliably.
 */
export function normalizeBrandKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`"]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Compact alphanumeric key without spaces, e.g. "7 Up" == "7UP", "Bona Papa" == "BonaPapa".
 */
export function normalizeBrandCompactKey(name: string): string {
  return normalizeBrandKey(name).replace(/\s+/g, '');
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;

  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const temp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = temp;
    }
  }
  return dp[n];
}

export function findExactBrandMatch(
  rawName: string,
  brands: Brand[],
  excludeBrandId?: string
): Brand | null {
  const key = normalizeBrandKey(rawName);
  const compact = normalizeBrandCompactKey(rawName);
  if (!key && !compact) return null;

  return (
    brands.find((b) => {
      if (excludeBrandId && b.id === excludeBrandId) return false;
      return (
        normalizeBrandKey(b.name) === key ||
        (compact.length >= 2 && normalizeBrandCompactKey(b.name) === compact)
      );
    }) || null
  );
}

export interface SimilarBrandMatch {
  brand: Brand;
  reason: 'Exact match' | 'Same brand (formatting variation)' | 'Close spelling match' | 'Similar name';
  score: number;
}

export function findSimilarBrands(
  rawQuery: string,
  brands: Brand[],
  excludeBrandId?: string,
  limit = 5
): SimilarBrandMatch[] {
  const qKey = normalizeBrandKey(rawQuery);
  const qCompact = normalizeBrandCompactKey(rawQuery);
  if (qCompact.length < 2) return [];

  const results: SimilarBrandMatch[] = [];
  const qTokens = qKey.split(' ').filter(Boolean);

  for (const b of brands) {
    if (excludeBrandId && b.id === excludeBrandId) continue;
    const bKey = normalizeBrandKey(b.name);
    const bCompact = normalizeBrandCompactKey(b.name);
    if (!bCompact) continue;

    if (b.name.trim().toLowerCase() === rawQuery.trim().toLowerCase()) {
      results.push({ brand: b, reason: 'Exact match', score: 1000 });
      continue;
    }

    if (bKey === qKey || bCompact === qCompact) {
      results.push({ brand: b, reason: 'Same brand (formatting variation)', score: 900 });
      continue;
    }

    const maxLen = Math.max(qCompact.length, bCompact.length);
    const maxDist = maxLen <= 4 ? 1 : maxLen <= 8 ? 2 : 3;
    const dist = levenshtein(qCompact, bCompact);

    if (dist <= maxDist) {
      results.push({ brand: b, reason: 'Close spelling match', score: 700 - dist * 50 });
      continue;
    }

    if (qCompact.length >= 3 && (bCompact.includes(qCompact) || qCompact.includes(bCompact))) {
      results.push({ brand: b, reason: 'Similar name', score: 450 });
      continue;
    }

    if (qTokens.length > 0) {
      const bTokens = bKey.split(' ').filter(Boolean);
      const shared = qTokens.filter((qt) =>
        bTokens.some((bt) => bt === qt || (qt.length >= 3 && (bt.startsWith(qt) || qt.startsWith(bt))))
      );
      if (shared.length > 0) {
        results.push({ brand: b, reason: 'Similar name', score: 300 + shared.length * 40 });
      }
    }
  }

  return results
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.brand.name.localeCompare(b.brand.name);
    })
    .slice(0, limit);
}

/**
 * Resolves canonical category IDs (`cat_diapers`, etc.) to a shop's live Category IDs,
 * handling shops where a canonical category exists under a custom doc ID.
 */
export function resolveBrandCategoryIds(
  canonicalCatIds: string[],
  liveCategories: Category[]
): string[] {
  const defaultById = new Map(DEFAULT_PRODUCT_CATEGORIES.map((c) => [c.id, c.name]));
  const liveById = new Map(liveCategories.map((c) => [c.id, c.id]));
  const liveByKey = new Map(liveCategories.map((c) => [normalizeCategoryKey(c.name), c.id]));

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const cid of canonicalCatIds) {
    let targetId = liveById.get(cid);
    if (!targetId) {
      const defName = defaultById.get(cid);
      if (defName) {
        targetId = liveByKey.get(normalizeCategoryKey(defName));
      }
    }
    const finalId = targetId || cid;
    if (finalId && !seen.has(finalId)) {
      seen.add(finalId);
      resolved.push(finalId);
    }
  }
  return resolved.slice(0, 25);
}

export function isBrandActive(brand: Brand): boolean {
  return brand.isActive !== false;
}

export function sortBrandsForDisplay<T extends { name: string; isActive?: boolean }>(brands: T[]): T[] {
  return [...brands].sort((a, b) => a.name.localeCompare(b.name));
}

export function formatBrandCategoryNames(
  brand: Brand,
  categoryMap: Map<string, string>,
  maxShown = 3
): string {
  const ids = Array.isArray(brand.categoryIds) ? brand.categoryIds : [];
  const names = ids.map((id) => categoryMap.get(id)).filter((n): n is string => Boolean(n));
  if (names.length === 0) return 'All categories';
  if (names.length <= maxShown) return names.join(', ');
  return `${names.slice(0, maxShown).join(', ')} +${names.length - maxShown} more`;
}
