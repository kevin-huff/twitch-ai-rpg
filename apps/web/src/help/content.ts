export type HelpTopic = {
  id: string;
  title: string;
  audience: Array<'host' | 'director' | 'producer' | 'player'>;
  sections: Array<{ heading: string; paragraphs?: string[]; steps?: string[] }>;
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
          'The Story Table runs a live tabletop roleplay on Twitch. Players send their lines from their own seats. The AI voices everyone else at the table, such as the narrator and the non-player characters.',
          'You are the director. You read every line before the audience sees it. Nothing is public until you publish it.',
        ],
      },
      {
        heading: 'Rehearsal show or custom show',
        paragraphs: [
          'A rehearsal show starts in one click, so you can learn the controls before a real episode. Use Create rehearsal session on the host home.',
          'A custom show uses your own scenario from the library. Each seat gets either a saved character card or a seat where the player writes their own character. Choose it when you are ready for a real episode. The Scenarios and characters topic explains the seat choices.',
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
          'A player invitation works once and expires after 7 days. After a player opens it, that seat stays signed in for 12 hours. When the 12 hours end, the player needs a new link from you. Make one with Reissue link under Seats & invitation links on the Cast & lobby page.',
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
        heading: 'One beat from start to finish',
        paragraphs: [
          'A beat is one round of play: the players send lines, you choose what goes in, and the AI writes the scene. The director page shows the next step at the top. Follow it and you will not get lost.',
        ],
        steps: [
          'Press Open conversation for talk, or Open action round when a character tries something risky. Players can now send lines.',
          'Tick the lines you want in this beat. Leave the rest unticked.',
          'Press Plan selected input. The AI proposes what each line means for the story.',
          'In an action round, read the stakes, then press Approve stakes. This is the point where you decide what a success, a cost or a setback looks like. The stage fits about 90 characters of a goal and 110 of each outcome, and the stakes editor counts them as you type, so shorten anything that runs long before you approve.',
          'Press Lock input. The chosen lines are fixed and the server rolls any dice. The results cannot change after this.',
          'Press Draft the scene. The AI writes the script, line by line.',
          'Read the script. Change what you do not like, then press Save script edits.',
          'If the AI proposes continuity updates, review them and press Approve continuity updates. Continuity is the record of facts the story must keep true.',
          'Publish. Press Publish text-only beat to show the text now. Or press Prepare draft narration, listen to it, then press Publish with narration.',
        ],
      },
      {
        heading: 'Actions in the queue',
        paragraphs: [
          'Players write an action as one plain description, so the queue shows a single line for it. The stakes step turns it into a goal and outcomes.',
        ],
      },
      {
        heading: 'A shortcut for plain conversation',
        paragraphs: [
          'When the stakes step shows an ordinary conversation with no dice, the gold button reads Lock and draft. One press does the work of Approve stakes, Lock input and Draft the scene.',
          'If any part fails, it stops at that step and shows the error. Carry on from there with the usual buttons.',
        ],
      },
      {
        heading: 'Playing narration on stream',
        paragraphs: [
          'Narration only plays in one browser source, called the presenter. The presenter is the main show link loaded in OBS. A text-only beat does not need a presenter. Viewers read it on the stage.',
          'Stage and OBS explains how to make that link.',
        ],
      },
      {
        heading: 'When drafting fails',
        paragraphs: [
          'The dice and the locked lines stay the same however many times you retry. Pick whichever of these fits.',
        ],
        steps: [
          'Press Draft the scene to ask the AI again. If a draft already exists, the button reads Regenerate script.',
          'Press Add manual narration or Add NPC dialogue and write the lines yourself.',
          'Open Abandon this beat if the beat cannot be saved. You give a reason, and published history stays as it was.',
        ],
      },
      {
        heading: 'Pausing the table',
        paragraphs: [
          'Press Pause table when the group needs a break. The stage shows a pause slate until you press Resume table. A player can also ask for a pause. You see the request on your page.',
        ],
      },
      {
        heading: 'Changes that clear queued lines',
        paragraphs: [
          'Lines players have sent but you have not locked can be cleared when the story changes under them. This happens when you publish a correction or change the scene or the cast. Players may need to send those lines again. Private direction for the AI clears nothing.',
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
        ],
        steps: [
          'Open the scenario editor in Library & custom shows and press Create the whole scenario with AI.',
          'In Describe your story, write a few sentences: where it happens, who is in it and what goes wrong. Your content boundaries are sent too, so the AI avoids what they rule out.',
          'Pick a Size. The AI aims for these numbers and may miss them. Small aims for 2 to 3 places and 2 to 3 characters, and can take up to 3 minutes. Medium aims for 3 to 4 places and 3 to 5 characters, and can take up to 4 minutes. Large aims for 5 to 7 places and 6 to 8 characters, and can take up to 6 minutes.',
          'Press Generate and keep the page open. You can switch to the character editor while you wait, and the draft keeps writing. Cancel only stops waiting. A draft that is already being written keeps going. When you open Create the whole scenario with AI again, the panel shows "Your earlier draft is still being written. It will appear here when it is ready." and then the preview.',
          'When the preview appears, press Load into the editor. If you have unsaved changes in the editor, the button reads Replace the editor with this draft, and those changes are lost.',
          'Check every field, then press Save scenario version.',
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
        heading: 'Suggested boundaries',
        paragraphs: [
          'The AI may suggest content boundaries that fit the story. It never changes the boundaries you already wrote. The preview lists the suggestions. They are added after yours, and the editor shows one notice above Content boundaries until you press Keep these boundaries.',
          'Read each one. Change or remove any you do not want, then press Keep these boundaries. Until you do, the Save scenario version button stays greyed out.',
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
        heading: 'Letting a player write their own character',
        paragraphs: [
          'When you create a custom show in Library & custom shows, every seat has a choice. Pick Player writes their own character, or pick a saved card. The first choice is the default. Each seat gets its own copy of a saved card, so you can change it for that show without touching the library.',
          'A player-written seat starts empty. The player opens Cast & lobby, finds Write your character, and writes the card there. You approve every card before you can start the show, whoever wrote it.',
        ],
      },
      {
        heading: 'Writing a card with AI',
        paragraphs: [
          'The card form has a button called Create the whole card with AI. You will find it on the character editor in the library, on the private link page and in Cast & lobby. It writes every box on the card, including the four traits, from a short description.',
        ],
        steps: [
          'Press Create the whole card with AI.',
          'In Describe your character, write a few words or a few sentences about who this character is.',
          'Leave Keep what I\'ve already written ticked to keep every box you already filled in. The AI then writes only the empty ones. Untick it to let the AI write everything again. Either way, the AI always picks the four traits again.',
          'Press Generate. A preview shows the name, the look, the personality and the traits.',
          'Press Use this character to fill in the form. Press Undo if you want your old card back. Press Cancel to close the panel without using the draft.',
          'Read every box, then save or submit the card as you normally would. Using the draft saves nothing and sends nothing.',
        ],
      },
      {
        heading: 'Pronouns the AI suggests',
        paragraphs: [
          'If your description gives pronouns, the AI copies them. If it does not, the AI may suggest some or leave the box blank. A suggestion is only a guess, so a person has to check it.',
          'After you use a draft with suggested pronouns, a notice appears next to the Pronouns box. Press Keep these pronouns to accept them, or change the Pronouns box yourself. Until you do one of those, the final save or submit button stays greyed out.',
        ],
      },
      {
        heading: 'Private character links',
        paragraphs: [
          'A private character link lets a player write their card days before the show. It lasts 30 days. The player can save an unfinished draft, then press Submit to director to send one card to your library for you to review. The link page has the same AI button as the other card forms.',
          'A seat sign-in is different. It comes from the invitation to a show and lasts 12 hours. A player who writes on show day does not need a link. They write the card in Cast & lobby.',
          'Choose a link when the player wants time to think. Choose Player writes their own character when the player is happy to write on the day.',
        ],
      },
      {
        heading: 'Waiting for a player\'s card',
        paragraphs: [
          'In Cast & lobby, a player-written seat shows Waiting for this player\'s card until the player submits. After that you can read the card and approve it. The show cannot start while any card is unapproved.',
        ],
      },
      {
        heading: 'When a player can\'t come',
        paragraphs: [
          'If a player cannot come, you can write their card for them. Their Test as link is at the top of the Cast & lobby page.',
        ],
        steps: [
          'Open that player\'s Test as link.',
          'In that tab, write the card under Write your character. You can use Create the whole card with AI for a first draft.',
          'Press Submit card for approval.',
          'Go back to your own tab in Cast & lobby and approve the card there.',
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
          'Sign in as host and open the host home.',
          'Find the Producer access panel.',
          'Type a name in Producer name, then press Create producer link.',
          'Press Copy link and send the link to that person. Treat it like a password.',
        ],
      },
      {
        heading: 'Showing the link again or taking access away',
        paragraphs: [
          'The Producer access panel lists everyone you have added. Press Show link to see a link again. Press Revoke, then Revoke access, to end someone\'s access. Press Keep access if you change your mind.',
          'Revoking takes effect at once. The producer is signed out of any page they have open. Stream links that producer made stay on, so check Stage & OBS links after revoking and switch off any you do not want.',
        ],
      },
      {
        heading: 'Signing in as a producer',
        paragraphs: [
          'The producer opens their link and presses Sign in as producer. The link works for 30 days. Each sign-in lasts 12 hours, or until the 30 days end if that comes first.',
          'When the 12 hours end, the producer reopens the same link and signs in again. If the link stops working, ask the host to show it again or make a new one.',
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
          'You can play without knowing anything about tabletop games. You write what your character says or does, and the director and an AI storyteller handle the rest.',
        ],
        steps: [
          'Open the invitation link you were sent, on the device you\'ll play on. Each link works once.',
          'Press Join session.',
          'Open Cast & lobby. If you see Write your character, this seat has no character yet. Write one there. Otherwise check the card you were given. Then read the content boundaries, which are the rules for what this story will and won\'t include.',
          'Press Submit card for approval if you wrote a card or changed the one you were given. The director has to approve it before the show can start.',
          'When the director approves your card, tick the box that starts "I reviewed my approved card", then press Mark ready. If the box or the button is greyed out, the director hasn\'t approved your card yet.',
          'Join the voice call and keep your seat page open for the whole show.',
        ],
      },
      {
        heading: 'Writing your character card',
        paragraphs: [
          'Your card tells the director and the AI storyteller who you are. You can leave a box short, but a name and the four traits are required. Each box in Cast & lobby means this:',
          'Name is what other characters call you. Pronouns are how the story refers to you, such as she/her, he/him or they/them. You can leave them blank. Appearance is what people notice first. Personality is how you act and talk. Backstory is where you came from.',
          'Specialty is something you are good at. Flaw is something that gets you into trouble. Connection is how you know the rest of the party. Possessions are up to three things you carry. Secret is something only you and the director know. The other players and the audience never see it.',
          'The four traits are Force, Finesse, Wits and Presence. Force is strength and tough physical action. Finesse is quick hands, sneaking and careful work. Wits is noticing things, knowing things and figuring things out. Presence is persuading, bluffing and performing. Give one trait +2, two traits +1 and one trait +0. The +2 is what your character does best. The +0 is what they do worst. The server adds these numbers when dice are rolled.',
          'If you are stuck, press Create the whole card with AI, describe your character in a few words, and press Generate. The AI fills every box and picks the traits. Check what it wrote, press Use this character, and change anything you like. If the AI suggests pronouns, press Keep these pronouns or change the Pronouns box before you submit. Nothing is sent until you press Submit card for approval.',
          'To give your character a portrait, say how they look in Appearance, press Create portrait and wait a few seconds. Press Use this portrait to keep it, or Try again for another one. The portrait goes to the director with your card. If there is no Create portrait button, pictures are off for this show.',
        ],
      },
      {
        heading: 'Your seat page',
        paragraphs: [
          'Your seat page is only for sending lines. You follow the story on the stream. From top to bottom, the page shows:',
        ],
        steps: [
          'The scene your character is in, with a small picture of it once one is made, and who you\'re playing (press Who is (your character)? to see your card and portrait again).',
          'A banner that says what\'s happening right now.',
          'How this works, a three-step reminder.',
          'The form: Say something, Do something, a box to write in, and Send.',
          'What you sent, with the progress of each line.',
          'Ask the director privately and Ask for a pause.',
          'Hear the story here, which plays the narration in your browser.',
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
          'Say something is for the exact words your character says out loud. For example: Who sent you, and what do they want? Viewers see your words, exactly as you typed them, once the director puts them in the story.',
          'Do something is for what your character tries, in plain words. For example: I climb the fire escape and look in the window. The storyteller tells what happens. Sometimes dice decide how it goes.',
          'When other characters are in the scene, Say something also shows Talking to. Pick who your character is talking to. Your group means the other players\' characters.',
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
          'To change a line, press Change, edit it, then press Save changes. To take one back, press Take it back, then press Take it back again to confirm. Press Keep it if you change your mind.',
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
          'Press Hear the story here at the bottom of the page to play the narration in your browser, in step with the show. Press Mute to stop it, and use Volume to set how loud it plays. If the stream is also playing near you, mute one of them, or you\'ll hear everything twice.',
        ],
      },
      {
        heading: 'Streaming the show yourself',
        paragraphs: [
          'If you stream on your own channel, you can make your own stream link. Open Cast & lobby and find My stream view.',
        ],
        steps: [
          'Press Show my stream view, then press Create my stream link.',
          'Pick a Layout. Full scene (1920×1080) is a whole picture. Transparent overlay sits on top of your camera.',
          'Pick an Audio setting. Listen only plays the narration in step with the show. Off plays no sound. Your link never carries the show audio.',
          'Press Copy link and paste the link into an OBS browser source. When you come back later, press Show link first.',
        ],
      },
      {
        heading: 'Hearing the narration twice',
        paragraphs: [
          'If your seat page is playing the story too, set your stream view\'s audio to Off, or you\'ll hear it twice. To switch your link off, press Revoke, then Turn off link.',
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
        heading: 'Who sees what I write?',
        paragraphs: [
          'The director sees every line first. Viewers see your Say something words only after the director puts them in the story. For Do something, the storyteller describes what happens in its own words. Private notes stay with the director.',
        ],
      },
      {
        heading: 'What are the dice for?',
        paragraphs: [
          'When a character tries something risky, the server rolls two dice to decide how it goes: a clean success, a success with a cost, or a setback. The stream shows the roll. You never roll anything yourself.',
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
          'Stay inside the content boundaries you accepted in Cast & lobby. If you\'re not sure about something, ask the director privately first.',
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
          'Seats stay signed in for 12 hours. If yours stops working, or your invitation says it\'s expired or already used, ask the host for a new link.',
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
          'This part is for the host and producers.',
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
    audience: ['host', 'director', 'producer'],
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
          'Open Cast & lobby and find the panel called Stage & OBS links. Press Show stage & OBS links if it is closed.',
          'Press Create main show link for the show itself. To make a link for one person, such as a player, the host or a producer, pick them in Create a personal link for and press Create link. Then set the Layout and Audio on that link. Players can also make their own link in Cast & lobby, under My stream view.',
          'Each link has a Show link button and a Copy link button. Treat a link like a password. Anyone who has it can watch that stream view. Press Revoke to switch a link off, then Turn off link to confirm. Press Keep link if you change your mind. A revoked link stops working at once.',
          'A stream link lasts 90 days. The OBS source keeps working for that whole time without anyone signing in.',
          'To check a link, press Open preview. Do not open the main show link in an ordinary browser tab.',
        ],
      },
      {
        heading: 'Choose the audio',
        paragraphs: [
          'Each link has an Audio setting. Broadcast audio plays the narration and character voices. Only the main show link can use it. Listen only plays the narration in step with the show on that screen, but it cannot take over the show audio. Off never plays sound.',
          'Use Broadcast audio on exactly one OBS source. If two sources play it, viewers hear every line twice. Set every other link to Listen only or Off. If another OBS source uses Listen only, mute it in the OBS Audio Mixer, or viewers hear the narration twice.',
          'Open preview is silent on purpose. It opens the stage with audio off, so it never takes the audio from OBS.',
        ],
      },
      {
        heading: 'Add the stage to OBS',
        steps: [
          'Copy the link from Show link in Stage & OBS links.',
          'In OBS, find the Sources box and press the + button. Choose Browser and give it a name.',
          'Paste the link into the URL box.',
          'Set Width to 1920, Height to 1080 and FPS to 30.',
          'Leave Custom CSS alone. The stage already handles its own background.',
          'Turn off Shutdown source when not visible. Turn off Refresh browser when scene becomes active. Either one can make the stage restart in the middle of a beat.',
          'On the main show source, tick Control audio via OBS. Then OBS lists the stage in the Audio Mixer and you can set its level.',
          'Do not also capture desktop audio for the same sound. That doubles the narration.',
          'For a Transparent overlay, switch on Studio Mode and look at the preview. You should see your camera through the stage with no black or grey box.',
          'If the picture ever looks wrong, right-click the source, choose Properties, and press Refresh cache of current page.',
        ],
      },
      {
        heading: 'What not to capture',
        paragraphs: [
          'Never capture the stage preview tab in a browser window. The preview has operator controls under the picture, and viewers would see them. Always capture a stream link.',
        ],
      },
      {
        heading: 'Check that it works',
        paragraphs: [
          'On the director page, the status strip shows Stage audio: OBS show link when the main show link in OBS holds the audio. It shows Stage audio: a stage preview tab when a preview tab holds it instead. If it shows no presenter, follow its Set up stage audio link.',
          'If a stream link has been revoked or has expired, the stage shows The story continues shortly. Make a new link and paste it into OBS.',
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
          'Characters can have portraits too. Players make their own with Create portrait. A non-player character gets one automatically when the whole-scenario AI writes it, or when the director adds it during the show.',
          'Pictures are drawn only from public details: the scene title and description, the place name, a character\'s appearance, role or specialty, and pronouns, and the show\'s picture style. Character names are taken out first, though a name that is also an everyday word, like Grey, stays when it is used on its own. Secrets, hidden identities and director notes are never sent. An action round\'s picture also uses the narration in its script and the appearance of the characters taking part. A picture of a beat uses the beat\'s public text and the people in it. The story AI reads those public details and writes the description of the picture. If it cannot, the server writes a plainer description from the same details.',
        ],
      },
      {
        heading: 'Who sees them',
        paragraphs: [
          'On the Full scene (1920×1080) stream, a new picture fills the screen for a few seconds with the show title and scene title. Then it moves into a panel beside the story. The story text keeps its place. Lines show the speaker\'s portrait next to the name. An action round\'s picture does the same when the round is published, or when the picture finishes if that comes later.',
          'The Transparent overlay shows a small picture in the top-left corner and portraits on the cast.',
          'Player seats show a small picture at the top, and the player\'s own portrait on their character card. Cast & lobby shows a portrait next to each character.',
          'A player\'s new portrait is seen only by that player and the director until the director approves the card.',
        ],
      },
      {
        heading: 'Scene pictures for the director',
        paragraphs: [
          'The Scene picture panel is on the director page. While a place picture is on its way it says Making the picture... While a picture of a beat is on its way it says Drawing the last beat…',
          'Press Draw the place to get a different picture of the current scene\'s place. Press Draw the last beat to draw the newest beat in this scene, with everyone who took part. Draw the last beat is greyed out until a beat has been published in this scene. Until then the panel says No beat has been published in this scene yet. It is also greyed out while the show has not started or is over.',
          'Pressing either button while a picture is on its way starts over. The new picture takes the old one\'s place when it is ready, and the old one is dropped. A round\'s picture waiting for you to publish is never touched by this. It stays held until you publish the round.',
          'Press Hide picture to take the picture off the stream and the player seats. Hide picture also works while a picture is being made, which keeps a new scene\'s picture off the stream before it appears. The panel then says Making the picture... It stays hidden until you press Show picture. Press Show picture to put it back. A hidden scene can always be shown again, and it stays hidden after Draw the place or Draw the last beat until you press Show picture.',
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
          'Open Write your character in Cast & lobby, your private character link, or the library character editor.',
          'Fill in the Appearance box. Say how the character looks.',
          'Press Create portrait and wait a few seconds.',
          'Press Use this portrait to keep it, or Try again for another one.',
          'Press Submit card for approval. On a private link the button is Submit to director. In the library it is Save character version.',
          'Press Remove portrait to take the portrait off the card. The director sees the portrait when approving.',
        ],
      },
      {
        heading: 'Portraits for non-player characters',
        paragraphs: [
          'After you press Load into the editor or Replace the editor with this draft, every character gets a portrait. Keep the page open until they finish.',
          'A portrait is drawn only from a character\'s Appearance and Role. Start Appearance with age and gender, for example "A woman in her forties with a folded apron", so the portrait matches.',
          'Each character in the scenario editor has Create portrait and Remove portrait. Press Create portraits for everyone to make the ones that are missing. Save scenario version stays greyed out while portraits are being made, and the editor says "Portraits are still being made. Save when they finish." When they finish, press Save scenario version. The editor shows Unsaved changes until you do.',
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
          'The panel shows the Private link. Anyone who has the link can open the gallery, and nobody else can find it. Press Copy link and paste it into chat. Ended shows that have a gallery turned on also get a tag under Resume a saved session on the host home page. That tag reads Gallery: private link, or Gallery: on the public list, and it has its own Copy link button.',
          'To let chat browse every gallery you have shared, press Add to public list. The panel then says On the public list and shows the list\'s address after Public list. Press Remove from public list to take the show off it. The private link keeps working.',
          'New link replaces the private link, and Turn off gallery removes the gallery. Each asks you first: This stops the link you may have posted in chat. Press Yes, make a new link or Yes, turn it off to go ahead, or Keep it to leave things as they are. Within about a minute, anyone who opens the old link sees: This gallery isn\'t available.',
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
    audience: ['host', 'director', 'producer', 'player'],
    sections: [
      {
        heading: 'You see "Sign in or redeem an invitation first."',
        paragraphs: [
          'This browser has no valid sign-in. A host or producer signs in again. A player needs a new invitation link, because each one works only once. Sign-ins last 12 hours, so this is common the morning after a session.',
          'If you opened a link in a private window, the sign-in is gone when you close it.',
        ],
      },
      {
        heading: 'You see "This invitation is expired, already redeemed, or invalid."',
        paragraphs: [
          'An invitation works once and lasts 7 days. If the player already opened it, or the 7 days passed, or part of the address was cut off when it was copied, it will not work.',
          'Ask the host for a new link. The host makes one with Reissue link under Seats & invitation links on the Cast & lobby page. Send it as plain text and check that the whole address came through.',
        ],
      },
      {
        heading: 'You see "This producer link is expired, revoked, or invalid. Ask the host for a new link."',
        paragraphs: [
          'The producer link ran out after 30 days, the host revoked it, or the address is incomplete. Only the host can fix this. The host opens the Producer access panel on the host home, then presses Show link, or creates a new link.',
          'If a producer is signed out in the middle of a session, the host probably revoked their access. Check the Producer access panel.',
        ],
      },
      {
        heading: 'OBS shows "The story continues shortly"',
        paragraphs: [
          'The stage cannot reach the show. The stream link may be switched off, the show may be closed, or the network may have dropped. The stage retries on its own.',
          'Open Cast & lobby and look at Stage & OBS links. If the link says it was turned off, create a new one and paste it into the OBS source.',
        ],
      },
      {
        heading: 'OBS shows a black box or a grey box',
        paragraphs: [
          'Use the Full scene layout for a solid picture and the Transparent overlay layout over cameras. If a transparent overlay shows a box, check that you left Custom CSS alone and that you are looking at the preview in Studio Mode. Then right-click the source, open Properties and press Refresh cache of current page.',
        ],
      },
      {
        heading: 'Nobody hears the narration',
        steps: [
          'Check that you published with narration. A text-only beat has no sound.',
          'Check that exactly one stream link uses Broadcast audio, and that it is the main show link loaded in OBS.',
          'In OBS, tick Control audio via OBS on that source, and check that it is not muted in the Audio Mixer.',
          'On the director page, check that the status strip says Stage audio: OBS show link. If it says Stage audio: a stage preview tab, a preview tab has taken the audio. Press Release audio on any open stage preview tab.',
          'To test a link, use Open preview. Do not open the main show link in an ordinary browser tab. A tab like that only listens. It does not play the broadcast audio.',
          'If a browser asks you to press Listen in this browser, press it. Browsers block sound until someone does.',
          'On a player\'s seat the same button is called Hear the story here.',
        ],
      },
      {
        heading: 'The narration plays twice',
        paragraphs: [
          'Two things are playing the same sound. Look for a second source set to Broadcast audio, another OBS source set to Listen only that is not muted, a player\'s own stream view set to Listen only while their seat is also playing the story, a desktop audio capture that picks up the first one, or a browser tab still open on the stage with Listen switched on. Turn off the extra ones. Only one source should have Broadcast audio.',
        ],
      },
      {
        heading: 'Drafting failed',
        paragraphs: [
          'The AI could not finish the script. Your locked lines and the dice are not affected. Press Draft the scene to try again. If a draft already exists, the button reads Regenerate script. You can also press Add manual narration or Add NPC dialogue and write the lines yourself. If the beat cannot be saved, open Abandon this beat.',
          'If the server restarts while the AI is writing, that script is lost. When the page shows Connected again, press Draft the scene once. If a draft already exists, the button reads Regenerate script.',
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
          'The player must finish setup first: read their card in Cast & lobby, tick the box and press Mark ready. After that they can send at any time, and the line waits for the next turn.',
          'The banner at the top of the seat says what is happening. \'Finish setup first\' shows when the player is not marked ready. \'The show is paused\' shows when the table is paused. \'Waiting for the next turn\' shows between beats. \'Getting the dice ready\' shows while you review the stakes of an action round, and \'The director is checking the lines\' while you review a conversation. In both, the player can still change their line. \'Lines locked in. The story is being written\' shows once a beat is locked with no roll. \'Dice rolled. The story is being written\' shows once a locked action round has a roll.',
          'If the page still looks wrong, ask the player to reload it.',
        ],
      },
    ],
  },
];

export const glossary: Array<{ term: string; definition: string }> = [
  { term: 'Beat', definition: 'One round of play. Players send lines, you pick which to use, and the AI writes a short scene. A beat ends when you publish it.' },
  { term: 'Conversation', definition: 'A beat for talking. Players send Say something lines and private notes, and there are no dice.' },
  { term: 'Action round', definition: 'A beat for something risky. A character tries a thing, you set the stakes, and the server rolls dice.' },
  { term: 'Stakes', definition: 'What a success, a cost or a setback would mean in the story. You approve them before the dice roll.' },
  { term: 'Contract', definition: 'The agreement for one character\'s action in an action round: the goal, the ruling, the trait, the risk and the outcomes.' },
  { term: 'Ruling', definition: 'Your decision on whether an action needs dice. Check means roll. No check means it works. Blocked means it cannot happen yet, and you explain what is missing. For No check and Blocked, the stage shows only the outcome that will happen, marked No roll needed or Blocked.' },
  { term: 'Trait', definition: 'One of a character\'s strengths, such as Wits. The server adds its value to the dice.' },
  { term: 'Risk', definition: 'How dangerous an action is. It is written in the contract and shown to viewers with the wager.' },
  { term: 'Edge', definition: 'A bonus of 1 that a character gets when a teammate helps with the action.' },
  { term: 'Outcome bands', definition: 'The three result groups. A total of 10 or more is a clean success. A total of 7 to 9 is a success with a cost. A total of 6 or less is a setback.' },
  { term: 'Strain', definition: 'How much pressure a character is under, from 0 to 4. At 4 the stage shows Needs help next to the character.' },
  { term: 'Track', definition: 'A meter for something that moves over time, such as progress, danger or a countdown. The scene layout shows up to three and the overlay layout shows up to two.' },
  { term: 'Continuity', definition: 'The record of facts the story must keep true, such as who is hurt or where an item is. You approve updates to it before you publish.' },
  { term: 'Input window', definition: 'The time when players can send lines. It opens when you start a conversation or action round and closes when you lock the input.' },
  { term: 'Presenter', definition: 'The one browser source allowed to play narration for the audience. It is the main show link in OBS.' },
  { term: 'Listen', definition: 'The Listen in this browser button, which lets a browser play the narration. On a player\'s seat it is called Hear the story here. Browsers stay silent until someone presses it.' },
  { term: 'Text-only beat', definition: 'A beat published as text with no narration. Viewers read it on the stage.' },
  { term: 'Test seat', definition: 'A seat you open yourself to try a character\'s view. It lets you check the player screen without inviting anyone.' },
  { term: 'Host', definition: 'The person who owns the show and signs in with the host token. Only the host manages producer access.' },
  { term: 'Director', definition: 'Whoever runs the beats. The host is a director, and so is a producer.' },
  { term: 'Producer', definition: 'A second director the host trusts. A producer has the same controls as the host, except managing producer access.' },
  { term: 'Boundaries', definition: 'The rules the table agreed on for what the story will and will not include. Players accept them before they can speak or act.' },
  { term: 'Stage', definition: 'The public page viewers see. OBS captures it from a stream link.' },
  { term: 'Scene layout', definition: 'The solid 1920×1080 picture of the stage, shown as Full scene (1920×1080).' },
  { term: 'Overlay layout', definition: 'The transparent version of the stage, shown as Transparent overlay, which sits on top of your cameras.' },
  { term: 'Character card', definition: 'The page that describes one character: name, pronouns, look, personality, backstory, four traits, up to three possessions and a private secret. The director approves every card before the show starts.' },
  { term: 'Character link', definition: 'A private web address a player uses to write a character card before the show. It lasts 30 days. The player can save a draft and submit one card to your library.' },
  { term: 'Stream link', definition: 'A private web address that OBS loads to show the stage. Each link has its own layout and audio setting, and can be switched off at any time.' },
];
