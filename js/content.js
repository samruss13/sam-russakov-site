/* =========================================================
   CONTENT — your four strengths.
   Shared by the main site (index.html) and the garage (garage/).
   Image paths are relative to the site root.
   ========================================================= */
export const PROJECTS = [
  {
    title: 'Track Days',
    cat: 'Performance',
    role: 'Analytical',
    img: 'assets/img/track.jpg',
    gallery: ['assets/img/track-2.jpg'],
    body: [
      'Every lap is a chance to get a little better.',
      'On track, improvement comes from a simple loop: review the data, find where time is being lost, make one deliberate change and measure the result. I take that same disciplined, data-driven approach into my professional work.',
      'Track driving has also taught me to stay calm and make clear decisions when things move fast, to take feedback without ego, and to respect the process that keeps everyone safe. I am always looking for the next tenth, in the car and on the job.',
    ],
  },
  {
    title: 'In the Details',
    cat: 'Approach',
    role: 'Detail-oriented',
    img: 'assets/img/m240i-badge.jpg',
    gallery: ['assets/img/m240i-front.jpg', 'assets/img/m240i-rear.jpg'],
    body: [
      'The difference is almost always in the details.',
      'I notice the small things: the setting that is almost right, the step that gets skipped when no one is checking, the finish that looks fine from a distance but not up close. Whether I am setting up a car for the track, planning a build or working with a team, I make a point of getting those things right.',
      'For me, attention to detail is not perfectionism for its own sake. It means catching problems early, following through on the last ten percent, and delivering work that holds up to a closer look.',
    ],
  },
  {
    title: 'Race Day',
    cat: 'Work Ethic',
    role: 'Committed',
    img: 'assets/img/running.jpg',
    focus: [0.5, 0.1], // crop focus (x, y from top-left, 0–1) — keeps the head in frame
    gallery: [],
    body: [
      'Race day is won in the weeks nobody sees.',
      'Running taught me that results come from consistency: showing up for the early mornings, putting in the work when it is not convenient, and trusting the preparation when it matters. I bring that same approach to my professional work.',
      'I set clear goals, put in steady effort to reach them, and stay composed under pressure. When a project hits its hardest stretch, I keep my pace, support the people around me and finish what I start.',
    ],
  },
  {
    title: 'The Build',
    cat: 'Problem Solving',
    role: 'Hands-on',
    img: 'assets/img/pc-build.jpg',
    gallery: ['assets/img/pc-build-2.jpg'],
    ratio: '4 / 3', // show photos at full 4:3 so nothing is cropped top/bottom
    heroRatio: '10 / 9', // first photo is taller; show the whole case
    body: [
      'Research first, then build it right.',
      'Building this computer from individual parts meant defining what it needed to do, researching every component, checking compatibility and staying within a budget before a single screw went in. I approach professional projects the same way: understand the requirements, plan carefully, then execute.',
      'When something does not work the first time, I troubleshoot methodically, one variable at a time, until I find the cause. I enjoy learning new technical skills on my own, and I take pride in work that is clean, organized and built to last.',
    ],
  },
];
