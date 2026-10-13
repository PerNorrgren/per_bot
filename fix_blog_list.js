// Per App 38 (9) — Per's request (13 Oct 2026): tidy the Blog list in
// Content › Writing › Blog.
//  - every blog title starts "Blog - ", typos corrected (thouht, Stilness,
//    Loosing, "transform you practice", Selfcare, relationship → relationships)
//  - the 20 course lesson notes that the WordPress import filed as blogs
//    become Course Material (they stay linked to their lessons, unchanged)
//  - the FELT FIBRE Facing Yourself First ebook becomes a Book
//  - "Self-Care #4 Nurturing Self-Care Poem" was imported with a file name
//    outside the library folder; if that file is not in storage it cannot
//    open, so the entry is removed (only if no lesson or playlist uses it)
// Each change is matched on the item's id AND its old value, so it runs
// once, and never overwrites anything Per has since edited by hand.

const TITLES = [
 [
  "d633d5b0-dc01-42a8-9981-28a916516aeb",
  "Self-Care #4 Nurturing Self-Care Poem",
  "Blog - Self-Care #4: Nurturing Self-Care Poem"
 ],
 [
  "c868926d-8f14-4da1-b1c0-29f3ad9bc63d",
  "A thouht for 2024",
  "Blog - A Thought for 2024"
 ],
 [
  "2b3c50c3-a8c6-4555-a5ea-d07292edc61a",
  "A thouht for 2024 - Let Go",
  "Blog - A Thought for 2024: Let Go"
 ],
 [
  "29ebcccd-cc78-4cea-b6c0-262a43676944",
  "Unlocking Self-Discovery Through Grounding in the Body",
  "Blog - Unlocking Self-Discovery Through Grounding in the Body"
 ],
 [
  "8826607f-fc67-4472-bd91-d852bd6677cc",
  "Embracing the Early Morning Practice: A Path to Awakening",
  "Blog - Embracing the Early Morning Practice: A Path to Awakening"
 ],
 [
  "63e6a046-ef15-4f87-ac3a-4a6f0984cb94",
  "Leadership Success: Achieve Clarity and Resilience with Deeper Mindfulness",
  "Blog - Leadership Success: Achieve Clarity and Resilience with Deeper Mindfulness"
 ],
 [
  "9982e872-f012-4405-8ad1-7864dc305881",
  "Deeper Mindfulness: Elevating Leadership with Tools for Focus and Resilience",
  "Blog - Deeper Mindfulness: Elevating Leadership with Tools for Focus and Resilience"
 ],
 [
  "ebf2aa9e-f7ed-44a1-868d-9918d579f3cd",
  "Mastering Stoic Wisdom: Control and Acceptance in Stoicism and Mindfulness",
  "Blog - Mastering Stoic Wisdom: Control and Acceptance in Stoicism and Mindfulness"
 ],
 [
  "7102cfa0-60d3-4f2f-b7fd-8c5821f2d08a",
  "Embracing the Pause: A Path to Decentering",
  "Blog - Embracing the Pause: A Path to Decentering"
 ],
 [
  "ba5322a1-0f8a-46b5-ae3b-69b900a1c234",
  "The Power of Embodiment: Building Trust Through Mindfulness",
  "Blog - The Power of Embodiment: Building Trust Through Mindfulness"
 ],
 [
  "b3d82bba-638c-464e-b6dd-e9ea40e913f8",
  "Liberating the Mind from Uncertainty: Deeper Mindfulness Insights",
  "Blog - Liberating the Mind from Uncertainty: Deeper Mindfulness Insights"
 ],
 [
  "8ea1c716-571b-4cad-b2c3-527a84a0de0d",
  "Embracing Self-Care: Your Number 1 Key to Unlocking Personal Growth",
  "Blog - Embracing Self-Care: Your Number 1 Key to Unlocking Personal Growth"
 ],
 [
  "e6c65aff-8256-42bb-bb79-8896b59061dd",
  "Embracing Mistakes with Kindness: 3 Important Steps to Self-care and Compassion",
  "Blog - Embracing Mistakes with Kindness: 3 Important Steps to Self-Care and Compassion"
 ],
 [
  "773ec38c-a520-4069-a386-de088d9b034b",
  "Self-Care 3: Future Self Encouragement",
  "Blog - Self-Care #3: Future Self Encouragement"
 ],
 [
  "1c691616-cc70-43e3-a62d-540e34f4518f",
  "Self-care #4 Nurturing Self-Care",
  "Blog - Self-Care #4: Nurturing Self-Care"
 ],
 [
  "257805f5-05d7-441f-ad64-8b8f44563f65",
  "Self-Care Blog 5 Steps to Warm Stilness of the Mind",
  "Blog - Self-Care #5: Steps to Warm Stillness of the Mind"
 ],
 [
  "dbdf847c-6497-4e3a-84a1-a5ac8fc2f91e",
  "News - Why Does Awe Inspire Us to Help Others?",
  "Blog - Why Does Awe Inspire Us to Help Others?"
 ],
 [
  "7a73f5d5-e2fd-4b27-9dc1-7a6400d8c94b",
  "Embracing Personal Growth: A four step Journey of the Soul",
  "Blog - Embracing Personal Growth: A Four-Step Journey of the Soul"
 ],
 [
  "95c1f9e6-cdf7-435e-8673-fd87c793e38b",
  "The Science of Sleep and Mindfulness: #1 Humorous Truth on Human Consciousness",
  "Blog - The Science of Sleep and Mindfulness: #1 Humorous Truth on Human Consciousness"
 ],
 [
  "606b6afe-704d-45d5-8276-f1c9bf4d7bd4",
  "Wellness and Wellbeing: A Three-step Journey of the Soul",
  "Blog - Wellness and Wellbeing: A Three-Step Journey of the Soul"
 ],
 [
  "5f6e6c30-e743-4841-9505-be3e72af71ac",
  "Wellbeing and Selfcare - A Path to Comfort",
  "Blog - Wellbeing and Self-Care: A Path to Comfort"
 ],
 [
  "35a46956-60a7-43ca-9f5b-c1f2ebcd8c52",
  "The Power of Listening",
  "Blog - The Power of Listening"
 ],
 [
  "0afed774-8979-49fc-9c85-db8d0b6f53db",
  "Setting Healthy Boundaries",
  "Blog - Setting Healthy Boundaries"
 ],
 [
  "91779215-377f-4817-920f-3fe27b62aa10",
  "1 Step to Reducing Loneliness",
  "Blog - 1 Step to Reducing Loneliness"
 ],
 [
  "a233d434-59ef-46bd-8f8c-8961982aad1b",
  "5 Powerful Ways to Master Your Emotions and Transform Your Life",
  "Blog - 5 Powerful Ways to Master Your Emotions and Transform Your Life"
 ],
 [
  "50d1dca5-0e72-4411-a3a7-39517e1fd447",
  "The Hidden Power of Home Practice",
  "Blog - The Hidden Power of Home Practice"
 ],
 [
  "2b0a3863-8fff-41f2-ab96-78df5edab4f4",
  "Self-Compassionate Touch",
  "Blog - Self-Compassionate Touch"
 ],
 [
  "8871b1c7-c23f-4652-94bd-0bf1dce956d1",
  "12 Points for Wellbeing in a Relationship",
  "Blog - 12 Points for Wellbeing in a Relationship"
 ],
 [
  "5adc1997-8118-48a1-ae71-06b381d1d609",
  "Finding Peace in the Chaos",
  "Blog - Finding Peace in the Chaos"
 ],
 [
  "d712b7b5-9f87-4a50-a3ef-5f5637a1f4e8",
  "The Mysterious Case of the Feeling Tone",
  "Blog - The Mysterious Case of the Feeling Tone"
 ],
 [
  "b53d3aa5-928e-45aa-b775-224397e9f49b",
  "Out of Your Head and Into Your Life",
  "Blog - Out of Your Head and Into Your Life"
 ],
 [
  "fe008c0b-a02c-4c9e-b0ea-832a977b87af",
  "Blog Grounded with Kindness",
  "Blog - Grounded with Kindness"
 ],
 [
  "b22d13b9-89c4-4cfb-8956-88c016060655",
  "Mindfulness Meditation Danger?",
  "Blog - Mindfulness Meditation Danger?"
 ],
 [
  "0fb70be2-21c1-4a38-9582-36a8b9e1d298",
  "Blog - Power of Forgiveness",
  "Blog - The Power of Forgiveness"
 ],
 [
  "d2a8fe5e-442f-4de3-9208-de19793b982e",
  "Blog Self-Worth at Work",
  "Blog - Self-Worth at Work"
 ],
 [
  "e58b6bfd-341d-4788-b282-a5de1098f9a1",
  "Blog Finding Purpose",
  "Blog - Finding Purpose"
 ],
 [
  "8dd4d11b-3bb8-43ff-9e92-8ecb4948e256",
  "Blog Connection and Belonging",
  "Blog - Connection and Belonging"
 ],
 [
  "f16e64d8-fbf7-4a1a-a99f-59bcba01b7ba",
  "Blog Proactive Hope",
  "Blog - Proactive Hope"
 ],
 [
  "cb6a4275-750e-429d-965b-810d7ddd96eb",
  "Blog Envision Positive Futures",
  "Blog - Envision Positive Futures"
 ],
 [
  "66280592-a389-4116-a1c1-005f0f3192a7",
  "Can You Shift from Fearful to Curious?",
  "Blog - Can You Shift from Fearful to Curious?"
 ],
 [
  "f2d69181-2061-44ab-b139-de54693237ad",
  "Blog What Are the Three Styles of Curiosity",
  "Blog - What Are the Three Styles of Curiosity"
 ],
 [
  "ae87d755-a72c-4c58-a437-8758dff99a1c",
  "Blog Turning Fear to Curiosity",
  "Blog - Turning Fear to Curiosity"
 ],
 [
  "e659199e-e000-4086-b682-916d741a527b",
  "Blog How a Meditation Timer can transform you practice",
  "Blog - How a Meditation Timer can transform your practice"
 ],
 [
  "95d89978-b2c7-4e9f-8b9f-172ddaf01a5a",
  "Blog - Poetry Brain Blog",
  "Blog - Poetry Brain"
 ],
 [
  "f44fcd14-35c9-4418-8912-1bcc0fc3b128",
  "Blog – Can’t Switch Off at Night? Cognitive Shuffling + Micro-Movements May Help",
  "Blog - Can’t Switch Off at Night? Cognitive Shuffling + Micro-Movements May Help"
 ],
 [
  "30f9dc6d-0979-4d69-9147-735de09fb8ca",
  "Blog - The Error that Heals - How to reprogramme your emotions",
  "Blog - The Error that Heals: how to reprogramme your emotions"
 ],
 [
  "008ee3b6-0823-43c4-835f-dec7fdc3e4f0",
  "Blog - Rooted strength - how to stand firm when the world shakes",
  "Blog - Rooted strength: how to stand firm when the world shakes"
 ],
 [
  "8136110c-f6e3-40a0-9e62-69d6f9e503ce",
  "Blog - Self-Expression letting life move through you",
  "Blog - Self-Expression: letting life move through you"
 ],
 [
  "cc913bbe-1ac5-452c-b0a2-cdc2c149ee01",
  "Blog - The hardest part of adult relationship - The past",
  "Blog - The hardest part of adult relationships: the past"
 ],
 [
  "e5438f52-f47d-40a6-b595-d37235323e16",
  "Blog -  What if the most powerful medicine you have is a memory?",
  "Blog - What if the most powerful medicine you have is a memory?"
 ],
 [
  "6e311a47-2981-47bc-ad4e-b356c797175a",
  "Blog -  What if the moment you’re in is already enough?",
  "Blog - What if the moment you’re in is already enough?"
 ],
 [
  "6a1e561a-de0e-493a-968e-682da27fd65d",
  "Blog -  Make this moment meaningful",
  "Blog - Make this moment meaningful"
 ],
 [
  "1d86cbc7-7b20-4183-975e-182985325bee",
  "Blog -  Ten emotional complexes - our inner world",
  "Blog - Ten emotional complexes: our inner world"
 ],
 [
  "b1a4e8f1-5a9c-47c8-b6cd-ba54d01d6bed",
  "Blog -  1 Existential safety complex",
  "Blog - 1 Existential safety complex"
 ],
 [
  "b1267393-3b44-48a5-bb61-4a96a2adccb3",
  "Blog -  2 Agency–Fairness complex",
  "Blog - 2 Agency–Fairness complex"
 ],
 [
  "8ce8e9d2-ebd0-45d1-b8c2-aec60b657871",
  "Blog -  ReCalibrate Belonging - Healing the Attachment Belonging Complex 3",
  "Blog - Recalibrate Belonging: Healing the Attachment–Belonging Complex 3"
 ],
 [
  "cbe8fe0f-0b1c-42ff-8d5a-ff1ba62681aa",
  "Blog -  Boundaries without backlash",
  "Blog - Boundaries without backlash"
 ],
 [
  "a57abfc9-0687-4325-8ac7-8c4e21cbf0d1",
  "Blog -  Loosing my Self Worth",
  "Blog - Losing my Self-Worth"
 ],
 [
  "e768cc82-bde7-4d79-895b-df8a407efaaa",
  "Blog -  Difficult Colleagues, really?",
  "Blog - Difficult Colleagues, really?"
 ],
 [
  "be4816eb-645d-4ec8-9207-f64127523667",
  "Blog -  Not Everyone Is a Narcissist",
  "Blog - Not Everyone Is a Narcissist"
 ],
 [
  "20d86f43-3ccb-41ce-a7d2-96ecafb7886b",
  "Blog -  When Caring Too Much Becomes a Burden",
  "Blog - When Caring Too Much Becomes a Burden"
 ]
];
const LESSON_NOTES = ["ed6e82af-55fb-44ef-b812-57d63c1142d2", "96bf8ee5-176d-42c1-83c1-427a66582574", "9349d362-8720-49fa-9cb4-a73705dc7311", "fbca0582-3f7e-438f-8085-3e14a24601d0", "35becfdc-5a10-4c2d-97ef-a668aa009cf6", "cd3f2656-a2db-48af-91b8-dde6dd380f9e", "b5bd321e-6182-45d8-b421-7b7b3af35f5d", "9307e0ea-4b74-4335-989f-3f8e279a343b", "9e1fc7fd-d397-477a-b7d7-e22bc841e28b", "969b4fea-2894-4cec-a948-4f542b96cc67", "10fa11cc-d39a-4233-ac91-1c1aac11e552", "dd31bc21-e735-4278-8c86-fb755c337170", "6830b3bb-3170-4575-a877-149d0455abb7", "052a969a-ad69-418a-b99f-4167ff649d1b", "fdd37be7-906e-460f-812d-cfc8f2f9c606", "a61d60fb-8bc5-414b-b720-5d9bca96acdd", "2c591e02-a747-4ffb-a6b2-35b80581d27f", "df17062e-cbcc-4f05-9715-75506c5e5373", "3254c921-fa59-4216-a0ac-4f1166531c10", "cbc231fc-2da5-4335-8ef9-633f0ad8f648"];
const BOOK_ID = "f2663a68-6eef-4c60-a740-bf4a952347a2";
const POEM_ID = "d633d5b0-dc01-42a8-9981-28a916516aeb";

async function cleanupBlogList(db, media, log = console.log) {
  let renamed = 0, moved = 0, book = 0, removed = 0;
  for (const [id, from, to] of TITLES) {
    const f = db.getLibraryFile(id);
    if (f && f.title === from) { db.updateLibraryFile(id, { title: to }); renamed++; }
  }
  const kinds = db.getAllContentKinds();
  const material = kinds.find(k => /^course material$/i.test(k.label));
  if (material) {
    for (const id of LESSON_NOTES) {
      const f = db.getLibraryFile(id);
      if (f && f.content_type === 'blog') { db.updateLibraryFile(id, { content_type: material.value }); moved++; }
    }
  }
  const b = db.getLibraryFile(BOOK_ID);
  if (b && b.content_type === 'blog' && kinds.some(k => k.value === 'book')) { db.updateLibraryFile(BOOK_ID, { content_type: 'book' }); book++; }

  const p = db.getLibraryFile(POEM_ID);
  if (p && media.isConfigured()) {
    try {
      const exists = await media.objectExists(p.filename);
      const usage = db.getFileUsage(POEM_ID);
      if (!exists && !usage.lessons.length && !usage.playlists.length) { db.deleteLibraryFile(POEM_ID); removed++; }
      else if (!exists) log('[content] Self-Care #4 poem file is missing but is used in a lesson or playlist; left in place.');
    } catch (e) { log('[content] could not check the Self-Care #4 poem file: ' + e.message); }
  }
  if (renamed || moved || book || removed) {
    log(`[content] blog list tidied: ${renamed} title(s) corrected, ${moved} lesson notes moved to Course Material, ${book} ebook moved to Book, ${removed} unopenable entry removed.`);
  }
  return { renamed, moved, book, removed };
}

module.exports = { cleanupBlogList };
