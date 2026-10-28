export type HelpTopic = {
  id: string;
  title: string;
  audience: Array<'host' | 'director' | 'producer' | 'player' | 'streamer'>;
  sections: Array<{ heading: string; paragraphs?: string[]; steps?: string[] }>;
};

export type HelpRole = 'host' | 'player' | 'streamer';

export const firstSteps: Record<HelpRole, string[]> = {
  host: [
    'Press Make a show, or Try it now to practise with no setup.',
    'Press Copy all invitations and send them to your cast.',
    'When every seat has a card, press Start show.',
    'Press Answer these lines, then Approve and roll, read the script, then press Publish.',
  ],
  player: [
    'Open your invitation link and press Join.',
    'Name your character and press Save my card. To let the AI fill in the rest, describe them first and press Write my card.',
    'Wait for the host to start the show.',
    'Type your line and press Send.',
  ],
  streamer: [
    'Open Stream this show.',
    'Press Copy overlay link or Copy full-scene link.',
    'Follow How to add this in OBS to paste it into a Browser source.',
  ],
};

export const topics: HelpTopic[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    audience: ['host', 'director', 'producer', 'player'],
    sections: [
      {
        heading: 'What The Story Table does',
        paragraphs: [
          'The Story Table runs a live tabletop roleplay on Twitch. Players send their lines from their own seats. The AI voices the narrator and the non-player characters. Your Say lines play in the voice you pick, or in the narrator\'s.',
          'You are the director. You read every line before the audience sees it. Nothing is public until you publish it.',
        ],
      },
      {
        heading: 'Two ways to start',
        paragraphs: [
          'When you sign in as host or producer, the home page offers two buttons. Try it now makes the practice show, The Ledger Job, and opens its director page straight away. It asks for nothing first, so you can learn the controls before a real episode. The Test as links on the Cast & lobby page let you open each seat yourself.',
          'Make a show opens a short page where you pick a story, set up the seats and create your own show. It is the way to start a real episode.',
          'Home is the start page. Your shows sits below the two buttons. It lists the shows you can open again, and each row has an Open the director page button. Library & custom shows is the full editor for scenarios and character cards, and More holds Producer access (host only).',
        ],
      },
      {
        heading: 'Making a show',
        paragraphs: [
          'You do not need to write anything by hand. A single sentence about the story is enough for the AI to draft one.',
        ],
        steps: [
          'Press Make a show.',
          'In What\'s the story?, write a few sentences, then press Write my story. Or pick one you saved earlier under Use a saved story. The size starts at Small. Medium and Large are under More options.',
          'Read the preview: the title, the premise, the places, the characters and the boundaries the AI suggests. Edit anything you like in the Library later. Press Use this story.',
          'Check the Show title. The show starts with four seats, and you can use Add a seat or Remove to get between two and six.',
          'Choose what each seat is: Player writes their own, Describe a character (one sentence about this character) or Use a saved card.',
          'Press Create show. The AI writes each described card while you wait. If one fails, press Try again, or choose Let the player write it.',
          'The page opens Cast & lobby for the new show.',
        ],
      },
      {
        heading: 'Getting the cast in',
        paragraphs: [
          'Cast & lobby opens with a Ready to start strip. It says how many seats have a card, for example Seats with a card: 3 of 4. Press Copy all invitations to copy one message with a line for each waiting player. Paste it wherever you talk to your cast. The strip also shows the Main show link, with Copy overlay link and Copy full-scene link buttons.',
          'Start show lights up when every seat has a card. A card made by you counts at once. A card a player writes counts the moment they save it, and you can still read any card with Read card and change it before the show starts.',
          'If a player has not written their card yet, the seat reads Waiting for this player\'s card. If a card has been saved for the seat but not used yet, it reads Card waiting to be used. Press Use this card to put it in the seat. If a seat has no card at all, press Write this card for them to write it yourself from one sentence, or Start without this seat to drop that seat.',
          'Players never mark themselves ready or accept anything. Content boundaries are limits on what the AI writes. They are not terms a player agrees to, and players never see them. You keep them under What the AI won\'t write.',
        ],
      },
      {
        heading: 'Keep your host token safe',
        paragraphs: [
          'You sign in as host with the Host access token. It is the HOST_TOKEN value in the .env file on the computer that runs the app.',
          'Never change that value. Your shows, your library and your producer access all belong to it. Every link you share is rebuilt from it, so a new token would break all of them.',
          'Never post it in chat or on stream. Anyone who has it can run your shows.',
        ],
      },
      {
        heading: 'How long things last',
        paragraphs: [
          'A player invitation works once and expires after 7 days. After a player opens it with Join, that seat stays signed in until the show ends. If a player is ever signed out, make a new link with Reissue link under Seats & invitation links on the Cast & lobby page. When the show has ended, the seat says The show is over and sends nothing.',
          'Your own sign-in as host or producer works in the whole browser, so a new tab or a bookmark is signed in too. It lasts 12 hours and renews while you use it. After about 12 hours without use it ends, and you sign in again. A Test as tab signs in for 12 hours too.',
          'Stream links and producer links last longer. The Stage and OBS topic and the Producers topic explain how long.',
        ],
      },
      {
        heading: 'Where to go next',
        paragraphs: [
          'Read Running a show before your first session. Read Scenarios and characters when you set up your own cast. Read Stage and OBS before you go live, and Pictures and portraits to see how scene pictures and portraits work. Players only need the Players topic, so send them that one.',
        ],
      },
    ],
  },
  {
    id: 'running-a-show',
    title: 'Running a show',
    audience: ['host', 'director', 'producer'],
    sections: [
      {
        heading: 'Before the show starts',
        paragraphs: [
          'A new custom show opens on Cast & lobby. Everything you need before the first beat is on that one page. The practice show from Try it now is different. It opens its director page with no setup.',
          'At the top is the Ready to start strip. It shows Seats with a card, for example 3 of 4, and the button Copy all invitations and the main show link, with Copy overlay link and Copy full-scene link. Start show lights up when every seat has a card. Once the show has started, the strip is called Invitations and show link and drops the count and the start button. Start show stays off while a card is still being saved.',
          'Below the strip is one line for each seat, with the character\'s portrait, the name and a closed Read card. A card you chose for the seat counts at once. A card a player saves counts the moment they save it, and nobody has to approve it. You can still open Read card and look it over before you start.',
          'A seat with no card yet reads Waiting for this player\'s card. Press Write this card for them, type one sentence about the character, then press Write the card. The AI writes the card and it goes straight into that seat. A seat that holds an unused saved card reads Card waiting to be used instead. Press Read card to see it and Use this card to keep it. Or press Start without this seat. The page asks Remove this seat? Its invitation stops working. Press Remove seat to confirm, or Keep seat to leave things as they are. At least one seat must stay, and you can only remove a seat before the show starts.',
          'To change a seat\'s card before the show starts, open Read card on that seat, press Change this card, then press Save this card. The player keeps the line Your host picked this character for you. Each seat line also has Test as, followed by the character\'s name. It opens that seat in a new tab, so you can try the player\'s view yourself.',
          'What the AI won\'t write is a closed section on the same page. Type one limit per line and press Save boundaries. The AI stays away from these when it writes. They are limits on the AI. Players never see them, never accept them, and saving them does not change any card or hold anyone up.',
          'Stream this show and Seats & invitation links sit below as closed sections. Press Start show when you are ready. It takes you straight to the director page. Later, when you come back to Cast & lobby during the show, Back to the show takes you to the director page again.',
        ],
      },
      {
        heading: 'One beat from start to finish',
        paragraphs: [
          'A beat is one round of play: the players send lines, you choose what goes in, and the AI writes the scene. The director page has one bar of actions with a single gold button, and the gold button is always the next thing to do. Above it the page says Step 1 of 5, and Step 1 of 3 only for an ordinary round, which is a plain conversation with no dice. A sentence says what comes next. A status line shows the work in progress, for example Planning… or Writing the script…. Everything else you might need sits in the closed More fold.',
        ],
        steps: [
          'Lines from players arrive already ticked. Untick any line you want to leave out of this beat.',
          'For a conversation, press Answer these lines. It opens the conversation, plans it and stops at What\'s at risk so you can look first. The gold button then reads Approve and roll.',
          'For something risky, press Open action round instead, then Plan. Plan plans the ticked lines in any round. The AI proposes what each line means for the story.',
          'Read the What\'s at risk cards. Each card shows the goal, the roll in words and four results: 10 or more is a clean success, 7 to 9 is a success with a cost, 6 or less is a setback, and a double 1 is a Critical failure whatever the total. Press Edit on a card to change it, then Done. The stage fits about 90 characters of a goal and 110 of each result. The character counts appear only inside a card\'s Edit, and only when a line runs over, so shorten anything over before you approve.',
          'Press Approve and roll. It approves the stakes, locks the lines and writes the script. The server rolls the dice once, at the lock, and the result never changes after that, however many times you retry.',
          'Read the script. You can edit a line, remove it, or pick Add a line to add narration or a non-player character line. When you have edited it, open More and press Save edits.',
          'Press Publish. The audience sees the beat once you do.',
        ],
      },
      {
        heading: 'Rolls, results and countdowns',
        paragraphs: [
          'Every line rolls, in conversations and in action rounds alike. Each ticked line gets a roll of its own, or it helps another line\'s roll.',
          'The AI sets how bad each result can get from the moment. A light or funny moment gets a small cost, and a dangerous one gets a heavy cost. Read the cards and edit anything that does not fit the scene.',
          'A double 1 is a Critical failure whatever the total, and the AI writes what happens in that case on its own line of the card. The stage shows it as Critical failure wherever results show. A card with no Critical failure line treats a double 1 as a setback.',
          'You can still waive a roll. Set a card to No check, so the action simply works, or to Blocked, so it cannot happen yet. You can also untick a line to leave it out of the round.',
          'Lock and draft appears only when you set a round to Ordinary conversation, which means no dice and nothing changes. Every other round goes through Approve and roll.',
          'Only action rounds tick countdowns. A conversation round rolls its dice without ticking them.',
        ],
      },
      {
        heading: 'The More fold',
        paragraphs: [
          'More holds the steps you need less often. Open conversation starts a plain conversation when you have no lines to answer. Approve stakes only approves the stakes. Roll the dice locks the lines and rolls once, and it is on only when the stakes are approved and unchanged. Plan again goes back and plans the lines afresh. Regenerate script writes the script again, and the box Tell the AI what to change lets you steer it. Save edits keeps the changes you made to the script. When the beat already has a Note for the AI, the box shows it as Current note, and what you type there replaces it. Regenerate script asks Replace the current draft? first; press Yes, regenerate, or Keep draft. With text in Tell the AI what to change, it asks only when the script has unsaved edits. Abandon this beat opens a short form where you give a reason, then press Abandon beat. Published history stays as it was.',
          'Players write a Do line as one plain description, so the queue shows a single line for it. The What\'s at risk cards turn each line into a goal and results.',
          'Every line a player sends can lead its own roll or help someone else\'s. A character can help only one roll in a round, and never their own. A character at 4 strain can still speak and roll on a Say line, but a Do line from them is blocked or helps someone else.',
          'A round shows at most six rolls, because the stream layouts have room for six. When more than six lines are ticked, the bar warns you before planning: it says how many rolls the lines need and asks you to untick some and plan the rest next round.',
        ],
      },
      {
        heading: 'Character voices',
        paragraphs: [
          'Each non-player character can have its own voice. In the live controls and the story editor, open Voice on a character and pick one, or leave it on Narrator. Press Play sample to hear a voice first. When the AI creates a story, it picks fitting voices for the cast, and you can change any of them.',
          'In the script review, a Read as line shows the exact words a voice will speak. In a manual script, the Delivery choice (Neutral, Quiet, Urgent or Amused) sets the tone of a line. The storyteller adds its own audio tags to the voice copy of each line, and the words never change.',
        ],
      },
      {
        heading: 'Publishing and narration',
        paragraphs: [
          'Player lines and actions go on stream before the script, in the player\'s own words with any audio tags left out. A Say line is read in the voice its player picked, or by the narrator when they picked none. A Do line is always read by the narrator, after the character\'s name. The director page lists them under Read aloud first, word for word. You cannot change them there. Only the script below them is yours to edit.',
          'Narration prepares by itself as soon as the script is ready. While it works the gold button reads Preparing voice…, and when it is done the page says Voice ready. If you press Publish while the voice is still preparing, the page says it is waiting for the voice and publishes the moment it is ready. You do not have to press anything twice.',
          'If you edit the script, save the edits under More before you publish. Until you do, Publish is off, because a publish would drop your edits.',
          'Narration plays on stream when you publish, and it waits for the previous narration to finish first. It plays in one browser source, called the presenter, which is the main show link loaded in OBS. When no presenter is open, the page shows No show audio: the main show link isn\'t open in OBS. That line only warns you, and it blocks nothing.',
          'Press Preview narration to hear the narration yourself before you publish, and Stop preview to stop it. If preparing the voice fails, the beat bar says: The voice could not be prepared. Press Prepare voice again, or Publish without voice. A short network blip does not count as a failure, and the page keeps checking. Prepare voice again tries once more. Publish without voice shows the beat as text only. Viewers read it on the stage.',
          'If the script proposes facts the story must keep true, they are listed under Facts to remember above the bar, and publishing keeps them. Tick Don\'t keep these to publish without them.',
        ],
      },
      {
        heading: 'When drafting fails',
        paragraphs: [
          'The dice and the locked lines stay the same however many times you retry. The bar shows the error, and the gold button reads Try again. Pick whichever of these fits.',
        ],
        steps: [
          'Press Try again to ask the AI again.',
          'Press Write it myself and write the lines yourself. Pick Add a line to add narration or a non-player character line. If you typed lines after Write it myself, Try again first asks Replace what you wrote? Press Yes, replace it, or Keep what I wrote.',
          'Open Abandon this beat under More if the beat cannot be saved. You give a reason, and published history stays as it was.',
        ],
      },
      {
        heading: 'Pausing the show',
        paragraphs: [
          'Press Pause show at the top of the director page when the group needs a break. The stage shows a pause slate until you press Resume show. While the show is paused, every other button in the bar is off and the gold button reads Resume show. A player can also ask for a pause. You see the request on your page.',
        ],
      },
      {
        heading: 'Ending the show',
        paragraphs: [
          'Press End show at the top of the director page. The page asks: End the show? Players will see that it\'s over, and it can\'t be restarted. Press End show to confirm, or Keep going to carry on. End show is refused only when a beat is locked or has a script. The page then tells you to publish or abandon that beat first.',
          'After the end, the pause and end buttons and the beat controls are gone, and the show\'s gallery moves to the top of the page. The gallery starts off. Press Turn on gallery first, and the panel then shows Gallery link and Copy link, the address of the public gallery. More gallery options holds the rest, closed until you want it.',
        ],
      },
      {
        heading: 'Show tools and the stage',
        paragraphs: [
          'Below the beat controls, the closed Show tools fold holds the things you reach for less often: live controls, corrections, Note for the AI, the room, scenario notes, what the party knows, the live state and the cast.',
          'If the narration does not start after you press Publish, the beat bar says so and offers Play latest reviewed beat. On the stage shows the first line of the latest beat. Show all opens that beat with the audio controls. Audio options, with Present audio and Release audio, is only on a Preview (not for OBS) tab.',
        ],
      },
      {
        heading: 'Note for the AI',
        paragraphs: [
          'Note for the AI, in Show tools, lets you give the AI a private hint for the beat, such as a mood or a thing to steer toward. Type it in Note for this beat, press Save note, and press Clear note to remove it. Players never see it. Saving or clearing a note throws away the current draft (or, before the dice are rolled, the stakes under review), so the AI writes it again with the note. The dice and the lines players sent stay.',
        ],
      },
      {
        heading: 'Changes that clear queued lines',
        paragraphs: [
          'Lines players have sent but you have not locked can be cleared when the story changes under them. This happens when you publish a correction or change the scene or the cast. Players may need to send those lines again. A Note for the AI does not clear lines players sent.',
        ],
      },
    ],
  },
  {
    id: 'scenarios-and-characters',
    title: 'Scenarios and characters',
    audience: ['host', 'director', 'producer'],
    sections: [
      {
        heading: 'Making a scenario from one idea',
        paragraphs: [
          'The scenario editor in Library & custom shows has a button called Create the whole scenario with AI. It turns a short idea into a full draft: places, an opening scene, characters with their private details, tracks, facts, hooks and objectives. The draft opens in the editor as a new, unsaved scenario. Nothing is saved until you press Save scenario version.',
          'If you only want a show, you can skip the editor. Make a show writes the story, saves it and builds the show on one page. The Getting started topic walks through it. Come to the editor when you want to change a story by hand.',
        ],
        steps: [
          'Open the scenario editor in Library & custom shows and press Create the whole scenario with AI.',
          'In Describe your story, write a few sentences: where it happens, who is in it and what goes wrong. The limits in What the AI won\'t write are sent too, so the AI avoids what they rule out.',
          'Pick a Size. The AI aims for these numbers and may miss them. Small aims for 2 to 3 places and 2 to 3 characters, and can take up to 3 minutes. Medium aims for 3 to 4 places and 3 to 5 characters, and can take up to 4 minutes. Large aims for 5 to 7 places and 6 to 8 characters, and can take up to 6 minutes.',
          'Press Generate and keep the page open. You can switch to the character editor while you wait, and the draft keeps writing. Cancel only stops waiting. A draft that is already being written keeps going. When you open Create the whole scenario with AI again, the panel shows "Your earlier draft is still being written. It will appear here when it is ready." and then the preview.',
          'When the preview appears, press Load into the editor. If you have unsaved changes in the editor, the button reads Replace the editor with this draft, and those changes are lost.',
          'Check the fields you care about, then press Save scenario version.',
        ],
      },
      {
        heading: 'What the scenario editor shows',
        paragraphs: [
          'The editor keeps the main boxes in view: Scenario title, Premise, What the AI won\'t write, and the opening scene. Each place and each non-player character is one line with its name, and a click opens it. A character you open shows Name, Role and Appearance. The rest of that character sits under More about this character.',
          'Everything else is in Fine-tune, a closed section: genre, tone, picture style, picture model, player hooks, objectives, discoveries, opportunities, tracks and facts, director notes and word targets. AI Generate buttons stay on the boxes you can see and inside the folds.',
          'At the bottom, Advanced tools holds Invite players to build characters (private character links) and the native JSON import and export. You rarely need them.',
        ],
      },
      {
        heading: 'What to check before saving',
        paragraphs: [
          'The AI makes mistakes, and it cannot know what you want to keep secret. The preview ends with a list called Check before you save, and a list called What the app changed that shows what the app fixed in the draft. Read both.',
          'Look for hidden identities in public text. The title, the premise, the opening scene, character names and looks, public tracks and public facts are all visible to players. A secret belongs in the character\'s private details or in a director fact.',
          'Check who starts where. Characters who are present begin at the opening place. Characters who are far away have a way to reach the table, such as a radio.',
          'Every track starts at zero. A countdown can tick each action round, but its effects stay manual. You decide what happens when it fills. The stage shows three public tracks at most.',
        ],
      },
      {
        heading: 'Boundaries the AI suggests',
        paragraphs: [
          'The AI may suggest limits that fit the story. It never changes the limits you already wrote. The suggestions are added after yours in What the AI won\'t write, with the note Added by the AI. Edit freely.',
          'Read them. Change or remove any you do not want. Nothing blocks Save scenario version, so you can save before you read them and come back later.',
          'These are limits on what the AI writes. They are not rules a player agrees to, and players never see them.',
        ],
      },
      {
        heading: 'When the scenario draft fails',
        paragraphs: [
          'If the AI cannot finish, the panel shows a message and a Try again button. Nothing was saved. The messages are:',
          'AI drafting is not available right now. You can still fill in the form yourself.',
          'The AI took too long. Try again, or fill in the form yourself.',
          'The AI\'s draft did not fit the form. Try again, or fill in the form yourself.',
          'A scenario draft is still being written. Wait for it to finish.',
          'The last message means a draft is already running, for example in another tab. Only one runs at a time. Wait a few minutes, then press Try again. A smaller Size fails less often. You can always add more by hand afterwards.',
        ],
      },
      {
        heading: 'Choosing who plays each seat',
        paragraphs: [
          'Every seat in a new show is one of three things. In Make a show the choices are Player writes their own (the default), Describe a character and Use a saved card. In Library & custom shows, the Create custom show form offers Player writes their own character or a saved card.',
          'Player writes their own leaves the seat empty. The player lands on their seat page after Join and writes the card there. A saved card is copied into the seat when the show is created, so you can change it for that show without touching the library. A card you choose this way counts at once, with no approval step.',
          'Describe a character takes one sentence per seat. When you press Create show, the AI writes a full card from the sentence and the story\'s premise, saves it in your library and puts it in the seat. Each seat shows Writing this card… while it waits, and several seats are written at the same time. If one fails, that seat shows Couldn\'t write this card. Press Try again, or press Let the player write it to leave the seat empty for the player.',
          'Creating a show takes you straight to Cast & lobby. There is no invitations screen to get through.',
        ],
      },
      {
        heading: 'Writing a card with AI',
        paragraphs: [
          'The card form is short. It has Character name, a Describe your character box with a Write my card button, and the line Only a name is needed. You will find the same form in the library character editor, on the private link page, on a player\'s seat page. A host changing a seat\'s card with Change this card uses the same short form. Writing a card for a waiting seat is different. That path is one sentence in a box and the Write the card button.',
        ],
        steps: [
          'Type a name if you have one.',
          'In Describe your character, write a few words or a few sentences about who this character is.',
          'Press Write my card. The AI writes the rest of the card from your description and keeps a name you typed. Other players\' cards are not sent. The button reads Writing… while it works, and Try again if something went wrong.',
          'Read the short summary under the box: the name, the look and the personality. Press Undo to put your old card back.',
          'Open More about your character for the full card: Pronouns, Appearance, Personality, Backstory, Specialty, Flaw, Connection to the party, Private secret, the four traits and the possessions. Each box has its own AI Generate button.',
          'Save the card as you normally would. Writing a card saves nothing and sends nothing by itself.',
        ],
      },
      {
        heading: 'Pronouns the AI suggests',
        paragraphs: [
          'If your description gives pronouns, the AI copies them. If it does not, the AI may suggest some or leave the box blank. A suggestion is only a guess.',
          'When the AI picked the pronouns, a line next to the box says The AI picked these pronouns. Change them if you like. Nothing blocks saving, so you can leave them or change them in More about your character whenever you like.',
        ],
      },
      {
        heading: 'Private character links',
        paragraphs: [
          'A private character link lets a player write their card days before the show. It lasts 30 days. You make one under Advanced tools in Library & custom shows, with Invite players to build characters. The player can save an unfinished draft, then press Submit to director to send one card to your library for you to read. The link page has the same short form as the other card forms.',
          'A seat sign-in is different. It comes from the invitation to a show and stays signed in until the show ends. A player who writes on show day does not need a link. They write the card on their seat page.',
          'Choose a link when the player wants time to think. Choose Player writes their own when the player is happy to write on the day.',
        ],
      },
      {
        heading: 'Waiting for a player\'s card',
        paragraphs: [
          'In Cast & lobby, a seat with no card shows Waiting for this player\'s card. When the player saves their card it counts at once. You can open Read card to see it. To change it before the show starts, press Change this card there, then Save this card. A seat that holds an unused saved card reads Card waiting to be used. Press Read card to see it and Use this card to keep it.',
          'The show cannot start while any seat is waiting. Start show lights up when every seat has a card.',
        ],
      },
      {
        heading: 'When a player can\'t come',
        paragraphs: [
          'If a player cannot write their card, you can write it for them, or drop the seat.',
        ],
        steps: [
          'In Cast & lobby, find the seat that says Waiting for this player\'s card.',
          'Press Write this card for them. Type one sentence about the character in Describe this character in one sentence, then press Write the card. The card goes straight into the seat.',
          'Or press Start without this seat. The page asks Remove this seat? Its invitation stops working. Press Remove seat to confirm, or Keep seat to change your mind. You can only remove a seat before the show starts, and at least one seat must stay.',
          'To see or change the card you just wrote, press Read card on that seat. To change it, press Change this card, then Save this card. Its Test as link opens the player\'s view if you want to check it from their side.',
        ],
      },
    ],
  },
  {
    id: 'producers',
    title: 'Producers',
    audience: ['host', 'producer'],
    sections: [
      {
        heading: 'What a producer is',
        paragraphs: [
          'A producer is a second director you trust. A producer can use everything you can: all of your shows, the library, character-builder links, invitations, test seats, stream links and every live control.',
          'A producer cannot create, show again or revoke producer access. Only you can do that.',
        ],
      },
      {
        heading: 'Giving someone producer access',
        steps: [
          'Sign in as host and open Home.',
          'Open More on Home, which is closed, then find the Producer access panel.',
          'Type a name in Producer name, then press Create producer link.',
          'Create producer link copies the link at once, and the page says Copied. Send it privately. It signs them in. Treat it like a password.',
        ],
      },
      {
        heading: 'Showing the link again or taking access away',
        paragraphs: [
          'The Producer access panel lists everyone you have added. Press Show link to see a link again. Press Turn off to end someone\'s access, and the page asks whether to turn off that person\'s access and sign them out of every tab right away. Press Turn off again to confirm, or Keep access if you change your mind. The status then reads Turned off.',
          'Turning off takes effect at once. The producer is signed out of any page they have open. Stream links that producer made stay on, so open Stream this show after turning off access and switch off any you do not want.',
        ],
      },
      {
        heading: 'Signing in as a producer',
        paragraphs: [
          'The producer opens their link and presses Sign in as producer. A producer\'s home leads with Shows you can run, with one row per show and an Open the director page button, or No shows yet. A producer with one show signs straight into its director page. The link works for 30 days. The sign-in works in the whole browser, so a new tab or a bookmark is signed in too. Keep the link private and open it again if you are ever signed out.',
          'A sign-in renews while it is used: each time the producer uses the app with less than 6 of the 12 hours left, it extends to 12 hours from then. It never lasts longer than the 30 days of the link. After about 12 hours without use it ends. The producer then reopens the same link and signs in again. If the link stops working, ask the host to show it again or make a new one.',
        ],
      },
      {
        heading: 'Two people on one beat',
        paragraphs: [
          'If you and a producer edit the same beat, the second save reports that the beat changed. Reload the page to see the latest version, then redo your change.',
        ],
      },
    ],
  },
  {
    id: 'players',
    title: 'Players',
    audience: ['player', 'host', 'director', 'producer'],
    sections: [
      {
        heading: 'Before the show',
        paragraphs: [
          'You can play without knowing anything about tabletop games. You write what your character says or does, and the director and an AI storyteller handle the rest. Before the show you need three things: press Join, make sure your character has a name, and wait for the director to start.',
        ],
        steps: [
          'Open the invitation link you were sent, on the device you\'ll play on. Each link works once. The page says "You\'ve been invited to play" and names the show. If it says "This invitation has already been used or has expired. Ask your host for a new link.", ask the host for a new link.',
          'Press Join to take your seat.',
          'You land on one page that stays your page until the show ends. It shows the show title, the premise and the cast. A seat with no card yet reads like Seat 2 · waiting, and your own seat is marked (you), for example Seat 2 (you) · waiting.',
          'Under Your character, check the card. If your host made it, the page says "Your host picked this character for you." You can play it as it is, or press Change my card to open the short card form.',
          'If your seat has no card, write one there. Type a name and press Save my card. Your card counts as soon as you save it. Nobody has to approve it, though the director can read it and change it before the show starts.',
          'If your host saves a different card for your seat while you are on the page, it says "Your host just saved a card for this seat." Press Use the host\'s card to take it, or Keep mine to keep yours. What you typed in Describe your character stays put. If the traits are not a valid spread, the page says "Give the four traits one +2, two +1 and one +0. They are under More about your character."',
          'Wait on the same page. It says "The show will start soon." When the director starts the show, the page turns into your seat. You do not press anything or reload.',
          'Join the voice call and keep the page open for the whole show.',
        ],
      },
      {
        heading: 'Nothing to accept',
        paragraphs: [
          'You never mark yourself ready, and you never accept any rules. The host can tell the AI what not to write, and those limits stay between the host and the AI. You do not see them, and nothing about them holds you back.',
          'The AI never writes your character\'s words or choices. What you send with Say something and Do something goes into the story in your words. Viewers never see audio tags such as [whispers].',
        ],
      },
      {
        heading: 'Writing your character card',
        paragraphs: [
          'The card form is short. Only a name is needed. Type it in Character name. If you save with only a name, the card is done.',
          'To get a fuller card quickly, write a sentence or two in Describe your character and press Write my card. The AI writes the rest of the card from your description and keeps a name you typed. Other players\' cards are not sent. Below the box you see a short summary of what it wrote. Press Undo to put your old card back.',
          'If you save without pressing Write my card and Appearance is empty, your description is saved as the card\'s Appearance. Nothing you typed is lost, and the live AI and the portrait both use it. If you press Save my card with no name, the page says "Give your character a name. Nothing has been saved."',
          'Everything else is in More about your character, a closed section. Open it to set Pronouns, Appearance, Personality, Backstory, Specialty, Flaw, Connection to the party and Private secret, plus the four traits and up to three possessions. Each box has its own AI Generate button.',
          'Pronouns are how the story refers to you, such as she/her, he/him or they/them. If the AI picked pronouns, a line says "The AI picked these pronouns. Change them if you like." They never stop you from saving.',
          'Appearance is what people notice first. Personality is how you act and talk. Backstory is where you came from. Specialty is something you are good at. Flaw is something that gets you into trouble. Connection to the party is how you know the others. Possessions are things you carry. Private secret is something only you and the director know. The other players and the audience never see it.',
          'The four traits are Force, Finesse, Wits and Presence. They start at +2, +1, +1 and +0, which is a valid spread, so you can leave them. Force is strength and tough physical action. Finesse is quick hands, sneaking and careful work. Wits is noticing things, knowing things and figuring things out. Presence is persuading, bluffing and performing. The +2 is what your character does best. The +0 is what they do worst. The server adds these numbers when dice are rolled.',
          'To give your character a portrait, say how they look in Describe your character or Appearance. When there is something to draw, Create portrait appears below the description. Wait a few seconds. Press Use this portrait to keep it, or Try again for another one. If there is no Create portrait button, pictures are off for this show.',
        ],
      },
      {
        heading: 'Your seat page',
        paragraphs: [
          'Your seat page is for sending lines, and it also shows The story, so you can follow what has happened without leaving it. The page has:',
        ],
        steps: [
          'The scene your character is in, with a small picture of it once one is made, and who you\'re playing (press Who is (your character)? to see your card and portrait again).',
          'A banner that says what\'s happening right now.',
          'The story, right under the banner. It shows the latest beat.',
          'How this works, a three-step reminder. It starts closed. Press it to open it.',
          'The form: Say something, Do something, a box to write in, and Send.',
          'What you sent, with the progress of each line.',
          'Ask the director privately and Ask for a pause.',
          'Sound, a closed line that holds the narration controls.',
        ],
      },
      {
        heading: 'The story',
        paragraphs: [
          'The story sits under the banner on your seat page. It shows the latest beat: the lines players sent, with their names, then the rolls, then the rest of the scene. A Do something line is tagged Action. A roll is written in words, for example Dash rolled 11: Clean success, or Dash rolled 3: Critical failure. It updates by itself when the director publishes a beat.',
          'Press Show the whole story to open every beat, oldest first, with the newest at the bottom. Press Hide the whole story to close it again. Before the first beat it says: The story starts when the director publishes the first beat.',
        ],
      },
      {
        heading: 'Sending a line',
        steps: [
          'Press Say something or Do something. The page picks the one that fits the moment, so you can often skip this step.',
          'Write in the box.',
          'Press Send. The page shows "Saved. The director has your line."',
        ],
      },
      {
        heading: 'Say something or Do something',
        paragraphs: [
          'Say something is for the exact words your character says out loud. For example: Who sent you, and what do they want? Viewers see your words, without any audio tags, and hear them in your voice (or the narrator\'s if you picked none), once the director puts them in the story. Your words can be rolled too, so the dice may decide how they land.',
          'Do something is for what your character tries, in plain words. For example: I climb the fire escape and look in the window. Viewers see these words on stream too, tagged Action, and the narrator reads them aloud. The storyteller then tells what happens, and the dice decide how it goes.',
          'When other characters are in the scene, Say something also shows who you are talking to, such as Talking to Mara or Talking to your group. Press Change to pick someone else. Your group means the other players\' characters.',
          'Every line you send can be rolled, whether you say it or do it. Most rolls end well or with a cost. A double 1 is a critical failure, whatever the total, and the story shows it as Critical failure.',
          'You can write at any time. If the story isn\'t taking new lines yet, yours waits for the next turn.',
        ],
      },
      {
        heading: 'After you send',
        paragraphs: [
          'Your lines appear under What you sent, each with a note on where it has got to. The list keeps every line still in play, plus your newest finished line and your newest private note.',
        ],
        steps: [
          '"Sent. Waiting for the director to pick lines." Change it or take it back.',
          '"Picked by the director. You can still change it." Change it or take it back.',
          '"Locked in. Watch the stream to see what happens." Nothing now. It\'s part of this turn.',
          '"This is in the story now." Nothing. It\'s done.',
          '"Not used. You took it back, or the story moved on. Send it again if it still fits." Write it again if it still fits.',
          '"Sent. Only the director sees it." This is a private note. Change it or take it back.',
        ],
      },
      {
        heading: 'Changing or taking back a line',
        paragraphs: [
          'To change a line, press Change, edit it, then press Save changes. Pressing Change clears the old "Saved" note, so the page shows only the line you are editing.',
          'To take a line back, press Take it back once. There is no second question. Your words return to the box as unsent text, so you can fix them and send them again.',
          'The director picks which lines go into the story, so some lines don\'t get used. That\'s normal.',
        ],
      },
      {
        heading: 'Private notes and pauses',
        paragraphs: [
          'Press Ask the director privately to write a note only the director sees. It never appears on stream. Press Send privately when it\'s ready.',
          'Press Ask for a pause if you need a break, and say so on the voice call too. The director decides when to pause.',
        ],
      },
      {
        heading: 'Hearing the story',
        paragraphs: [
          'Open Sound at the bottom of the page. Press Hear the story here to play the narration in your browser, in step with the show. Press Mute to stop it, and use Volume to set how loud it plays. If the stream is also playing near you, mute one of them, or you\'ll hear everything twice.',
        ],
      },
      {
        heading: 'Streaming the show yourself',
        paragraphs: [
          'If you stream on your own channel, you have a stream link of your own. Press Stream this show at the top of any page you can open. The Streaming from your own OBS topic has the full steps.',
        ],
        steps: [
          'Open Stream this show. Your card is called Your own stream link, and it is made for you the first time you open the panel.',
          'Press Copy overlay link for captions, cast and dice over your own camera. Press Copy full-scene link for the whole show as one 1920×1080 picture.',
          'Paste the link into an OBS browser source. How to add this in OBS on the card lists the steps.',
        ],
      },
      {
        heading: 'Hearing the narration twice',
        paragraphs: [
          'If your seat page is playing the story too, open Sound options on your link\'s card and pick Off, or you\'ll hear it twice. If your link stops working, Stream this show makes a fresh link the next time it loads. Copy it again and paste it into OBS.',
        ],
      },
      {
        heading: 'Do I need to know how to play tabletop games?',
        paragraphs: [
          'No. Write what your character says or does in plain words. The director and the AI storyteller handle the rules and the dice.',
        ],
      },
      {
        heading: 'What should I write?',
        paragraphs: [
          'Whatever your character would say or try next. Talk to the other characters or try something. Short lines work well, because viewers read them on stream. If you\'re stuck, press Ask the director privately and ask what your character could do.',
        ],
      },
      {
        heading: 'Your voice and Help me say it',
        paragraphs: [
          'Open Your voice on your seat to pick a voice for your character. Press Play sample to hear a voice before you choose it. Voices marked Tuned for v4 suit the voice model best. Once you pick one, your Say lines play in it. The narrator keeps reading what you do. Choose The narrator reads my lines to go back.',
          'A line can carry a few audio tags in square brackets, such as [whispers], [laughs] or [sighs], to set how it is read. They only change the voice. Viewers never see them, and a line needs real words as well as tags.',
          'Help me say it turns a rough idea into a fuller line in your character\'s voice. Type the idea in the line box, press Help me say it, and read the suggestion. Choose Use this to put it in the box, Try again for another, or Keep mine to leave your words alone. Nothing is sent until you press Send. It only knows what your own seat shows.',
        ],
      },
      {
        heading: 'Who sees what I write?',
        paragraphs: [
          'The director sees every line first. Viewers see your Say something and Do something words, without audio tags, only after the director puts them in the story. Say lines are read in your chosen voice or the narrator\'s, and Do lines by the narrator. The storyteller then describes what happens in its own words. Private notes stay with the director.',
        ],
      },
      {
        heading: 'What are the dice for?',
        paragraphs: [
          'Every line you send can be rolled. The server rolls two dice to decide how it goes: a clean success, a success with a cost, or a setback. A double 1 is a critical failure whatever the total, and the AI writes what happens then. The stream shows the roll. You never roll anything yourself.',
        ],
      },
      {
        heading: 'Can I change my mind after I send?',
        paragraphs: [
          'Yes, until your line says Locked in. Press Change or Take it back.',
        ],
      },
      {
        heading: 'What if the page reloads while I\'m typing?',
        paragraphs: [
          'Your unsent words come back with the note "Your unsent words are back." Read them again before you send, because the story may have moved on.',
        ],
      },
      {
        heading: 'What does "The story moved on while you were typing" mean?',
        paragraphs: [
          'The director moved the story along while you were writing, for example by locking the lines or starting a new turn. Read your words again. If they still fit, press Yes, they still fit, then press Send.',
        ],
      },
      {
        heading: 'Is there anything I shouldn\'t write?',
        paragraphs: [
          'Write what your character would say or do. The host can limit what the AI writes about, but that is the AI\'s rule, not yours, and you have nothing to accept. If you\'re not sure about something, ask the director privately first.',
        ],
      },
      {
        heading: 'The page says Reconnecting. What do I do?',
        paragraphs: [
          'Wait a moment. The page reconnects by itself. Your unsent words stay in your browser, and nothing gets sent without you.',
        ],
      },
      {
        heading: 'What if my seat stops working?',
        paragraphs: [
          'Your seat stays signed in until the show ends, so it should keep working. If you are ever signed out, or your invitation says "This invitation has already been used or has expired. Ask your host for a new link.", ask the host for a new link. After the show ends, the page says The show is over and accepts nothing.',
        ],
      },
      {
        heading: 'Can I play on my phone?',
        paragraphs: [
          'Yes. The seat page fits a phone screen.',
        ],
      },
      {
        heading: 'Giving a player a new link',
        paragraphs: [
          'This part is for the host and producers. A new link signs the player in until the show ends, like the first one.',
        ],
        steps: [
          'Open Cast & lobby and press Show seats & invitation links.',
          'Each seat shows where it stands: Waiting, Joined or Expired. For a seat that is still Waiting, press Show link to see its link again.',
          'To replace a link, press Reissue link. If the old link went to the wrong person or leaked, tick Also sign out whoever is using the old link. Then press Reissue, or Cancel to stop.',
          'Press Copy link on the new link and send it to the player. The old link stops working at once.',
        ],
      },
    ],
  },
  {
    id: 'stage-and-obs',
    title: 'Stage and OBS',
    audience: ['host', 'director', 'producer', 'streamer'],
    sections: [
      {
        heading: 'What OBS loads',
        paragraphs: [
          'The stage is the page viewers see on Twitch. OBS (Open Broadcaster Software) loads it from a stream link, so there is nothing to click and no sign-in screen. A stream link is a web address that belongs to one show. You can switch it off at any time.',
          'The stage never shows buttons, sliders or error messages for the operator. Those stay on the director page.',
        ],
      },
      {
        heading: 'Pick a layout',
        paragraphs: [
          'Full scene (1920×1080) is a solid picture: story text, dice, facts and the cast. Use it when the stage is the whole screen.',
          'Transparent overlay has no background. It adds captions, dice, the wager and the cast as small panels over your cameras, and keeps the middle of the screen clear except for the wager panel while stakes are up. Use it when you place the stage on top of a camera or game scene.',
          'You choose the layout for each link, so one show can have both.',
        ],
      },
      {
        heading: 'Make the links',
        paragraphs: [
          'Press Stream this show in the header. It is on the seat, pre-show, director and Cast & lobby pages. A director goes to the Stream this show panel in Cast & lobby, and a player goes to their own panel. The panel opens by itself and loads the first time it opens.',
          'Links come in groups. For your stream holds the Main show link. Every new show already has one, made with the show, and Make the main show link appears only when a show has none. For a cast member\'s own stream has one card for each cast member, with the name as its title, plus Host view and any producer\'s link. They are made the first time you open the panel. A producer also sees For your own stream.',
          'Each card has two copy buttons. Copy overlay link copies captions, cast and dice over your own camera, on a see-through background. Copy full-scene link copies the whole show as one 1920×1080 picture. The page says Copied, or Copy failed with the link selected for you to copy by hand. Treat a link like a password. Anyone who has it can watch that stream view.',
          'Press Turn off, then Turn off to confirm, to switch a link off. Press Keep link if you change your mind. OBS sources using a turned off link switch to a holding screen within seconds. The row then says Turned off. and offers Make a new link.',
          'A stream link lasts 90 days. The main show link made with a new show lasts 90 days too. The OBS source keeps working for that whole time without anyone signing in.',
          'To check a link, press Preview (silent) on its card. The overlay preview sits on a checker background so you can see it is see-through. Do not open the main show link in an ordinary browser tab.',
        ],
      },
      {
        heading: 'Choose the audio',
        paragraphs: [
          'The sound is set for you. The main show link carries the show audio, the narration and character voices. A cast member\'s link plays the narration only where it is opened, and it cannot take over the show audio.',
          'Only one OBS source should carry the show audio. If two do, viewers hear every line twice. Open Sound options on a card to pick Show audio (main show link only), Listen only or Off. If this computer also plays the story, turn this link\'s sound off or you\'ll hear it twice.',
          'Preview (silent) plays no sound on purpose, so it never takes the audio from OBS.',
        ],
      },
      {
        heading: 'Add the stage to OBS',
        paragraphs: [
          'Press How to add this in OBS on a card to see these steps.',
        ],
        steps: [
          'In OBS, open Sources, press +, and choose Browser.',
          'Paste the link into URL.',
          'Set Width to 1920 and Height to 1080.',
          'Untick Shutdown source when not visible and Refresh browser when scene becomes active.',
          'For the main show link only: Tick Control audio via OBS.',
          'Do not also capture desktop audio for the same sound. That doubles the narration.',
        ],
      },
      {
        heading: 'What not to capture',
        paragraphs: [
          'Preview (not for OBS) opens the stage in a browser tab for you to look at. Its strip reads Preview only, not for OBS. For OBS, use a link from Stream this show. The preview has operator controls under the picture, and viewers would see them, so never capture it. Always capture a stream link. Press Back to the director page to return. On a preview tab, Audio options holds Present audio and Release audio.',
        ],
      },
      {
        heading: 'Check that it works',
        paragraphs: [
          'On the director page, a No show audio chip means the main show link is not open in OBS. Its Stream this show link takes you to the links. If the chip reads Can\'t check the show audio, reload the page.',
          'If a stream link has been turned off or has expired, the stage shows The story continues shortly. Make a new link and paste it into OBS.',
        ],
      },
    ],
  },
  {
    id: 'streaming-your-own-obs',
    title: 'Streaming from your own OBS',
    audience: ['player', 'streamer'],
    sections: [
      {
        heading: 'Why you might want your own link',
        paragraphs: [
          'A cast member who streams can show the story on their own channel. You get a stream link of your own, so your OBS (Open Broadcaster Software) shows the same show as the main one, with captions, dice and the cast over your own camera.',
          'A stream link needs no sign-in, and the host or you can turn it off at any time.',
        ],
      },
      {
        heading: 'Get your link',
        steps: [
          'In Cast & lobby, open Stream this show. If you are on a seat or the pre-show page, press Stream this show there.',
          'Find Your own stream link. It is made for you the first time you open the panel.',
          'Press Copy overlay link for captions, cast and dice over your own camera on a see-through background. Press Copy full-scene link for the whole show as one 1920×1080 picture.',
          'Copied appears when the link is on your clipboard. If it says Copy failed, select the link in the box and copy it by hand.',
        ],
      },
      {
        heading: 'Add it to OBS',
        paragraphs: [
          'Press How to add this in OBS on the card to see the same steps. Treat the link like a password. Anyone who has it can watch your stream view.',
        ],
        steps: [
          'In OBS, open Sources, press +, and choose Browser.',
          'Paste the link into URL.',
          'Set Width to 1920 and Height to 1080.',
          'Untick Shutdown source when not visible and Refresh browser when scene becomes active.',
          'Use Preview (silent) on the card to check the picture first. It plays no sound.',
        ],
      },
      {
        heading: 'Sound',
        paragraphs: [
          'Your own link plays the narration only where it is opened, so your viewers can hear it. Only the main show link in the host\'s OBS carries the show audio.',
          'If this computer also plays the story, turn this link\'s sound off or you\'ll hear it twice. Open Sound options on the card and pick Off.',
        ],
      },
      {
        heading: 'If your link stops working',
        paragraphs: [
          'The host can turn your link off. The stage then shows The story continues shortly. Stream this show makes a fresh link by itself the next time it loads. Just copy it again and paste it into OBS.',
        ],
      },
    ],
  },
  {
    id: 'pictures-and-portraits',
    title: 'Pictures and portraits',
    audience: ['host', 'director', 'producer', 'player'],
    sections: [
      {
        heading: 'What the pictures are',
        paragraphs: [
          'Each scene gets a picture of the place, a few seconds after the scene starts. That happens when the show goes live and every time the director changes the scene. Nobody has to press anything.',
          'Each action round gets its own picture too, as long as its script has narration. Drawing starts as soon as the script is drafted. Only the director sees it until the round is published, so it never gives away what happens. Then it stays up until something replaces it. A picture made with Draw the place or Draw the last beat replaces the round\'s picture when it finishes, and the next action round\'s picture replaces it in turn. The stream always shows the newest moment, so when you publish a round that has its own picture, a Draw the place picture still being made is dropped, because the round is newer. A new scene replaces both. Conversations keep the scene\'s picture.',
          'A picture of a beat shows everyone who took part in it, drawn to look like their portraits. Action round pictures work the same way. The director presses Draw the last beat to make one for the newest beat in the scene. Everyone with a ready portrait is drawn from it, using the first 10 portraits. Anyone after the tenth, and anyone without a portrait, is described in words instead. Nobody is left out.',
          'Characters can have portraits too. Players make their own with Create portrait. When you create a custom show and pictures are on, every non-player character that has no portrait gets one automatically, as long as it has an appearance or a role. You do not press anything, and creating the show never waits for them. A non-player character you add during the show also gets one automatically.',
          'Pictures are drawn only from public details: the scene title and description, the place name, a character\'s appearance, role or specialty, and pronouns, and the show\'s picture style. Character names are taken out first, though a name that is also an everyday word, like Grey, stays when it is used on its own. Secrets, hidden identities and director notes are never sent. An action round\'s picture also uses the narration in its script and the appearance of the characters taking part. A picture of a beat uses the beat\'s public text and the people in it. The story AI reads those public details and writes the description of the picture. If it cannot, the server writes a plainer description from the same details.',
        ],
      },
      {
        heading: 'Who sees them',
        paragraphs: [
          'On the Full scene (1920×1080) stream, a new picture fills the screen for a few seconds with the show title and scene title. Then it moves into a panel beside the story. The story text keeps its place. Lines show the speaker\'s portrait next to the name. An action round\'s picture does the same when the round is published, or when the picture finishes if that comes later.',
          'The Transparent overlay shows a small picture in the top-left corner and portraits on the cast.',
          'Player seats show a small picture at the top, and the player\'s own portrait on their character card. Cast & lobby shows a portrait next to each character.',
          'A player\'s new portrait shows on their card as soon as they keep it. Nobody approves it.',
        ],
      },
      {
        heading: 'Scene pictures for the director',
        paragraphs: [
          'The Scene picture panel is on the director page. While a place picture is on its way it says Making the picture... While a picture of a beat is on its way it says Drawing the last beat…',
          'Press Draw the place to get a different picture of the current scene\'s place. Press Draw the last beat to draw the newest beat in this scene, with everyone who took part. Draw the last beat is greyed out until a beat has been published in this scene. Until then the panel says No beat has been published in this scene yet. It is also greyed out while the show has not started or is over.',
          'Pressing either button while a picture is on its way starts over. The new picture takes the old one\'s place when it is ready, and the old one is dropped. A round\'s picture waiting for you to publish is never touched by this. It stays held until you publish the round.',
          'Press Hide picture to take the picture off the stream and the player seats. Hide picture and Show picture work at any time, even while the gold button is busy with a beat. Hide picture also works while a picture is being made, which keeps a new scene\'s picture off the stream before it appears. The panel then says Making the picture... It stays hidden until you press Show picture. Press Show picture to put it back. A hidden scene can always be shown again, and it stays hidden after Draw the place or Draw the last beat until you press Show picture.',
          'Under the buttons the panel says: Draw the place makes a new picture of this scene\'s place. Draw the last beat draws the newest beat in this scene, with everyone who took part. Pressing either one while a picture is on its way starts over. The new picture takes the old one\'s place when it is ready.',
          'During an action round the panel also tells you about the round\'s own picture. While it is being made it says Making the picture for this action round. Viewers and players see it when you publish the round. When it is ready it shows a small preview and says The picture for this action round is ready. Viewers and players see it when you publish the round. If it fails it says The picture for this action round could not be made. You can still publish the round, and the stream keeps the picture it has now. When the reason is the picture service account, the server\'s key or a refusal to draw the round, the panel says that instead. For a refusal it says The picture service would not draw this round. You can still publish it.',
          'Hide picture and Show picture work the same for action round pictures: while the scene is hidden, a published round\'s picture stays hidden too. Draw the place always draws the scene from its description.',
          'Pictures of a beat and of an action round take longer than a place picture, because the story AI writes the description first. Expect anywhere from 25 seconds to 2 minutes. The show never waits for a picture.',
          'If something goes wrong, the panel says one of these. For a place picture: The picture could not be made. Press Draw the place to try again. Or: The picture service would not draw this scene. Press Draw the place to try again. For a beat picture: The picture of the last beat could not be made. Press Draw the last beat to try again. Or: The picture service would not draw this beat. Press Draw the last beat to try again. The show never waits for a picture.',
        ],
      },
      {
        heading: 'Picture settings',
        paragraphs: [
          'The Scene picture panel has a Picture settings fold-out, closed until you open it. It holds the look and the model for this show\'s pictures.',
          'Art style is the one look for every picture in the show. Type your own, press one of the quick picks (Painterly, Comic book ink, Watercolor storybook, Anime, Dark fantasy oil painting, Cinematic photo, Pixel art or Film noir), or press AI Generate, then Generate, for a suggestion.',
          'Picture model chooses which model draws place pictures, portraits, and pictures of a beat where nobody has a portrait. Under the choice you see a short note about the model you picked. A model marked (server default) is the one the server uses when you have not chosen. The fold-out also says: Pictures of a beat use FLUX 3 Klein when anyone in them has a portrait, because it is the only model that can draw your cast from their portraits.',
          'Press Save picture settings to keep your choices for this show. A change applies to pictures started after you save. Pictures already on their way are not redrawn.',
        ],
      },
      {
        heading: 'Portraits for players',
        steps: [
          'Open your card: on your seat page under Your character, on your private character link, or in the library character editor. Press Change my card first if the card is shown as a summary.',
          'Say how the character looks in Describe your character, or fill in Appearance under More about your character. Press Write my card if you want the AI to write the rest.',
          'Once there is something to draw, Create portrait appears below the description. Press it and wait a few seconds.',
          'Press Use this portrait to keep it, or Try again for another one.',
          'Save the card. On a seat page the button is Save my card. On a private link it is Submit to director. In the library it is Save character version.',
          'Press Remove portrait to take the portrait off the card.',
        ],
        paragraphs: [
          'There is no approval step. The portrait is on the card when you save it. If there is no Create portrait button, pictures are off for this show, or there is nothing to draw yet.',
        ],
      },
      {
        heading: 'Portraits for non-player characters',
        paragraphs: [
          'When you create a custom show and pictures are on, the server makes a portrait for every non-player character that has none and has an appearance or a role. You do not press anything. Creating the show never waits for the portraits, and the show works without them. They appear in Cast & lobby and on the stage as they finish.',
          'A portrait is drawn only from a character\'s Appearance and Role. Start Appearance with age and gender, for example "A woman in her forties with a folded apron", so the portrait matches.',
          'In the scenario editor in Library & custom shows, each character you open has Create portrait and Remove portrait. After you press Load into the editor or Replace the editor with this draft, the editor makes portraits for its characters while you read. Press Create portraits for everyone to make the ones that are missing.',
          'Save scenario version is never greyed out because portraits are still being made. If portraits finish after you save, they land in the form and the editor says Portraits finished. Save again to keep them in the library. The editor shows Unsaved changes until you do.',
          'A character added during the show with Create or edit character gets a portrait automatically. In the room on the director page also has Create portrait.',
        ],
      },
      {
        heading: 'The picture style',
        paragraphs: [
          'Every scenario has a Picture style field. It sets one look for all the pictures in the show: art style, colors and light. Press AI Generate beside it, then Generate, for a suggestion, or let the whole-scenario AI fill it in.',
          'The style is sent exactly as written, so leave character and place names out of it.',
          'If you leave it blank, pictures use Painterly digital illustration, rich color, cinematic lighting.',
          'A show copies the style when it is created. Library cards made outside a show use the default style. Inside a show, the Picture settings fold-out on the director page can change the style for that show.',
          'The scenario editor also has a Picture model choice beside Picture style. Its note says: The model that draws place pictures, portraits, and pictures of a beat where nobody has a portrait, in shows made from this scenario. Server default uses the server\'s setting. When anyone in a beat has a portrait, FLUX 3 Klein draws the picture.',
        ],
      },
      {
        heading: 'Sharing the pictures with chat',
        paragraphs: [
          'After a show has ended, the director page has a Gallery panel. Press Turn on gallery to write a page of every picture from the show. Before the show ends, the panel only says: The gallery opens once the show has ended.',
          'The panel shows the Gallery link. Anyone who has the link can open the gallery, and nobody else can find it. Press Copy link and paste it into chat. Ended shows that have a gallery turned on also get a tag under Your shows on Home. That tag reads Gallery: link only, or Gallery: on the public list, and it has its own Copy link button.',
          'To let chat browse every gallery you have shared, press Add to public list. The panel then says On the public list and shows the list\'s address after Public list. Press Remove from public list to take the show off it. The gallery link keeps working.',
          'New link replaces the gallery link, and Turn off gallery removes the gallery. Each asks you first: This stops the link you may have posted in chat. Press Yes, make a new link or Yes, turn it off to go ahead, or Keep it to leave things as they are. Within about a minute, anyone who opens the old link sees: This gallery isn\'t available.',
          'If a picture is still being made when you turn the gallery on, the panel tells you. It is added when it finishes. Write the gallery again is always there while the gallery is on. Press it if a page looks out of date, or after the panel shows a message that the gallery could not be written.',
          'A gallery holds everything that was drawn. That includes hidden pictures, earlier drafts and action rounds that were never published. Those carry a tag, Not shown on stream or Hidden, so chat can tell them from what was on stream. Under each picture, How this was drawn shows the model and the prompt. The prompt is also the picture\'s alt text, the description that screen readers read aloud.',
          'Each player character shows only the portrait you kept, so a try that was thrown away is never shown. Every non-player portrait is shown.',
          'While the app runs only on your own computer, the panel adds a note: These links only work on this computer until the app is deployed.',
        ],
      },
      {
        heading: 'Limits',
        paragraphs: [
          'Ten pictures can be made at once, which is the picture service\'s own limit for one account. Pictures made in the picture service\'s own app on the same account count toward it. Others wait for a free turn for as long as they are still wanted. If the picture service itself says it is busy, you see: Pictures are busy right now. Try again in a minute.',
          'A picture of a beat uses at most ten portraits, because that is the most FLUX 3 Klein can take.',
          'There is no limit on how many pictures a show, a scene or a character can have.',
          'The host can also set an hourly limit on the server. When it is used up you see a message such as: The picture limit for this hour is used up. Try again in 12 minutes.',
        ],
      },
      {
        heading: 'When a picture fails or pictures are off',
        paragraphs: [
          'The show goes on without the picture. A portrait that fails shows a message next to the button, and you can press Try again.',
          'If the server has no picture service switched on, picture areas are hidden and the editors say Pictures are off on this server.',
        ],
      },
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    audience: ['host', 'director', 'producer', 'player', 'streamer'],
    sections: [
      {
        heading: 'You see "Sign in or redeem an invitation first."',
        paragraphs: [
          'This browser has no valid sign-in. A host or producer signs in again with their token or producer link. That sign-in works in the whole browser, so a new tab or a bookmark is signed in too. It renews while you use it and ends after about 12 hours without use, so this is common the morning after a session.',
          'A player seat stays signed in until the show ends, so a player sees this only after being signed out, for example by clearing the browser\'s data. They need a new invitation link, because each one works only once.',
          'If you opened a link in a private window, the sign-in is gone when you close it.',
        ],
      },
      {
        heading: 'You see "This invitation has already been used or has expired."',
        paragraphs: [
          'The invitation page shows "This invitation has already been used or has expired. Ask your host for a new link." before anyone presses Join. If someone opens the link in two places and presses Join in the second after the first, the server answers "This invitation is expired, already redeemed, or invalid." Both mean the same thing.',
          'An invitation works once and lasts 7 days. If the player already opened it, or the 7 days passed, or part of the address was cut off when it was copied, it will not work.',
          'Ask the host for a new link. The host makes one with Reissue link under Seats & invitation links on the Cast & lobby page. Send it as plain text and check that the whole address came through.',
        ],
      },
      {
        heading: 'You see "This producer link is expired, revoked, or invalid. Ask the host for a new link."',
        paragraphs: [
          'The producer link ran out after 30 days, the host revoked it, or the address is incomplete. Only the host can fix this. The host opens the Producer access panel on Home, then presses Show link, or creates a new link.',
          'If a producer is signed out in the middle of a show, the host probably revoked their access. Check the Producer access panel.',
        ],
      },
      {
        heading: 'OBS shows "The story continues shortly"',
        paragraphs: [
          'The stage cannot reach the show. The stream link may be switched off, the show may be closed, or the network may have dropped. The stage retries on its own.',
          'Press Stream this show and look at the link\'s card. If the row says Turned off., press Make a new link and paste the new link into the OBS source.',
        ],
      },
      {
        heading: 'OBS shows a black box or a grey box',
        paragraphs: [
          'Use the full-scene link for a solid picture and the overlay link over cameras. If a transparent overlay shows a box, check that you left Custom CSS alone and that you are looking at the preview in Studio Mode. Then right-click the source, open Properties and press Refresh cache of current page.',
        ],
      },
      {
        heading: 'Nobody hears the narration',
        steps: [
          'Check that you did not press Publish without voice. A beat published without voice has no sound.',
          'Check that the main show link is the one loaded in OBS. It is the only link that carries the show audio.',
          'In OBS, tick Control audio via OBS on that source, and check that it is not muted in the Audio Mixer.',
          'On the director page, look for the No show audio chip, or the line No show audio: the main show link isn\'t open in OBS. If you see either, the main show link is not open in OBS, so open it there. If a Preview (not for OBS) tab has taken the audio, open Audio options on that tab and press Release audio.',
          'To test a link, use Preview (silent) on its card. Do not open the main show link in an ordinary browser tab. A tab like that only listens. It does not play the broadcast audio.',
          'If a browser asks you to press Listen in this browser, press it. Browsers block sound until someone does.',
          'On a player\'s seat the same button is called Hear the story here.',
        ],
      },
      {
        heading: 'The narration plays twice',
        paragraphs: [
          'Two things are playing the same sound. Look for a second source carrying the show audio, another OBS source set to Listen only that is not muted, a cast member\'s own link playing while their seat is also playing the story (open Sound options on the card and pick Off), a desktop audio capture that picks up the first one, or a browser tab still open on the stage with Listen switched on. Turn off the extra ones. Only the main show link should carry the show audio.',
        ],
      },
      {
        heading: 'Drafting failed',
        paragraphs: [
          'The AI could not finish the script. Your locked lines and the dice are not affected. Press Try again on the director page. You can also press Write it myself and write the lines yourself. If the beat cannot be saved, open Abandon this beat under More.',
          'If the server restarts while the AI is writing, that script is lost. When the page shows Connected again, press Try again once, or Draft the scene if that is what the gold button says.',
        ],
      },
      {
        heading: 'A scenario draft fails or takes too long',
        paragraphs: [
          'Nothing was saved, so you lose nothing. Read the message in the panel. \'The AI took too long. Try again, or fill in the form yourself.\' means the draft ran past its limit of 3, 4 or 6 minutes for Small, Medium or Large, or the page lost touch with the server while it waited. Press Try again, or pick a smaller Size. \'A scenario draft is still being written. Wait for it to finish.\' means a draft is already running, for example in another tab. Only one runs at a time. Wait a few minutes, then press Try again. A finished draft stays on the server for 15 minutes, and after that it has to be generated again. If the panel says the draft is no longer on the server, press Generate again.',
        ],
      },
      {
        heading: 'A message says the session changed',
        paragraphs: [
          'Someone else, or another tab, changed the show after your page loaded. This happens when the director and a producer work at the same time, or when a scene or the boundaries change. Press Refresh state or reload the page. Read what the page shows now, then repeat your change.',
        ],
      },
      {
        heading: 'A player cannot send',
        paragraphs: [
          'A player needs only two things before they can send: the show has started, and their seat has a card. There is no ready step and no rules to accept. If a player cannot send, check these in order.',
          'Before the show starts, the player sees their seat page with "The show will start soon." and cannot send yet. Start the show from Cast & lobby with Start show. If the button is off, a seat still has no card. Open Cast & lobby, find the seat that says Waiting for this player\'s card, and press Write this card for them, or ask the player to type a name under Your character and press Save my card. If the page says "Give your character a name. Nothing has been saved.", no name was typed yet.',
          'The banner at the top of the seat says what is happening. \'The show is paused\' shows when the show is paused. \'Waiting for the next turn\' shows between beats. \'Getting the dice ready\' shows while the director reviews the stakes, and \'The director is checking the lines\' shows only when the approved stakes need no roll. In both, the player can still change their line. \'Lines locked in. The story is being written\' shows once a beat is locked with no roll. \'Dice rolled. The story is being written\' shows once a locked round has a roll.',
          'After the director ends the show, the seat says The show is over and sends nothing. If the page still looks wrong, ask the player to reload it.',
        ],
      },
    ],
  },
];

export const glossary: Array<{ term: string; definition: string }> = [
  { term: 'Beat', definition: 'One round of play. Players send lines, you pick which to use, and the AI writes a short scene. A beat ends when you publish it. The page counts it as Step 1 of 5, and as Step 1 of 3 only for an ordinary round.' },
  { term: 'Conversation', definition: 'A beat for talking. Players send Say something lines and private notes. The lines roll like an action round\'s, but a conversation round does not tick countdowns. Only a round you set to Ordinary conversation has no dice.' },
  { term: 'Action round', definition: 'A beat for something risky. Each line a player sends rolls: it leads its own roll or helps another character\'s. You set the stakes, and the server rolls dice once per roll. Only action rounds tick countdowns. A round shows at most six rolls.' },
  { term: 'What\'s at risk', definition: 'The cards that show what a success, a cost, a setback or a Critical failure would mean in the story. Conversation rounds and action rounds both stop here. You approve them with Approve and roll before the dice roll.' },
  { term: 'Contract', definition: 'The agreement for one roll: the goal, the ruling, the trait, the risk and the outcomes, including the Critical failure. A character leads it, and others may help. A character helps only one contract in a round.' },
  { term: 'Ruling', definition: 'Your decision on whether an action needs dice. Check means roll. No check means it works. Blocked means it cannot happen yet, and you explain what is missing. For No check and Blocked, the stage shows only the outcome that will happen, marked No roll needed or Blocked.' },
  { term: 'Trait', definition: 'One of a character\'s strengths, such as Wits. The server adds its value to the dice.' },
  { term: 'Risk', definition: 'How dangerous an action is: low for light or funny stakes, normal for humiliating or costly ones, high for dangerous ones. The AI sets it from the moment. It is written in the contract and shown to viewers with the wager.' },
  { term: 'Edge', definition: 'A bonus of 1 that a character gets when a teammate helps with the action.' },
  { term: 'Outcome bands', definition: 'The four result groups. A total of 10 or more is a clean success. A total of 7 to 9 is a success with a cost. A total of 6 or less is a setback. A double 1 is a Critical failure, whatever the total.' },
  { term: 'Critical failure', definition: 'The result of a double 1, whatever the total. The AI writes its own outcome for each roll, a clear step worse than the setback, and the stage shows it as Critical failure. A card without one treats a double 1 as a setback.' },
  { term: 'Strain', definition: 'How much pressure a character is under, from 0 to 4. At 4 the stage shows Needs help next to the character.' },
  { term: 'Track', definition: 'A meter for something that moves over time, such as progress, danger or a countdown. The scene layout shows up to three and the overlay layout shows up to two.' },
  { term: 'Facts to remember', definition: 'The facts the story must keep true, such as who is hurt or where an item is. They are listed above the bar when a script proposes them, and publishing keeps them unless you tick Don\'t keep these.' },
  { term: 'Note for the AI', definition: 'A private hint you give the AI for one beat, under Show tools. Players never see it.' },
  { term: 'Input window', definition: 'The time when players can send lines. It opens when you start a conversation or action round and closes when the lines are locked.' },
  { term: 'Presenter', definition: 'The one browser source allowed to play narration for the audience. It is the main show link in OBS.' },
  { term: 'Listen', definition: 'The Listen in this browser button, which lets a browser play the narration. On a player\'s seat it is called Hear the story here. Browsers stay silent until someone presses it.' },
  { term: 'Text-only beat', definition: 'A beat published with Publish without voice. It has no narration. Viewers read it on the stage.' },
  { term: 'Test seat', definition: 'A seat you open yourself to try a character\'s view. It lets you check the player screen without inviting anyone.' },
  { term: 'Host', definition: 'The person who owns the show and signs in with the host token. Only the host manages producer access.' },
  { term: 'Director', definition: 'Whoever runs the beats. The host is a director, and so is a producer.' },
  { term: 'Producer', definition: 'A second director the host trusts. A producer has the same controls as the host, except managing producer access.' },
  { term: 'Boundaries', definition: 'The limits you set on what the AI writes, shown as What the AI won\'t write. They are a list for the AI. Players never see them and never accept them, and they do not hold a player back.' },
  { term: 'Stage', definition: 'The public page viewers see. OBS captures it from a stream link.' },
  { term: 'Scene layout', definition: 'The solid 1920×1080 picture of the stage, shown as Full scene (1920×1080).' },
  { term: 'Overlay layout', definition: 'The transparent version of the stage, shown as Transparent overlay, which sits on top of your cameras.' },
  { term: 'Character card', definition: 'The page that describes one character: name, pronouns, look, personality, backstory, four traits, up to three possessions and a private secret. A card counts as soon as it has a name and is saved. You can read any card before the show starts.' },
  { term: 'Character link', definition: 'A private web address a player uses to write a character card before the show. It lasts 30 days. The player can save a draft and submit one card to your library.' },
  { term: 'Stream link', definition: 'A private web address that OBS loads to show the stage. Each link has its own layout and audio setting, and can be switched off at any time.' },
];
