CREATE TABLE IF NOT EXISTS magnets (
    id SERIAL PRIMARY KEY,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    rotation INTEGER NOT NULL,
    word TEXT NOT NULL,
    last_modifier UUID
);

WITH words_array AS (
    SELECT array['&','a','about','above','ache','ad','after','all','am','an','and','apparatus','are','arm','as','ask','at','away','bare','be','beat','beauty','bed','beneath','bitter','black','blood','blow','blue','boil','boy','breast','but','butt','by','can','chant','chocolate','cool','could','crush','cry','d','day','death','delirious','diamond','did','do','dream','dress','drive','drool','drunk','eat','ed','egg','elaborate','enormous','er','es','est','fast','feet','fiddle','finger','fluff','for','forest','frantic','friend','from','garden','girl','go','goddess','gorgeous','gown','hair','has','have','he','head','heave','her','here','him','his','honey','hot','how','I','if','in','ing','is','it','juice','lake','language','languid','lather','lazy','less','let','lick','lie','life','light','like','live','love','luscious','lust','ly','mad','man','me','mean','meat','men','milk','mist','moan','moon','mother','music','must','my','need','never','no','not','of','on','one','or','our','over','pant','peach','petal','picture','pink','play','please','pole','pound','puppy','purple','put','r','rain','raw','recall','red','repulsive','rip','rock','rose','run','rust','s','sad','said','sausage','say','scream','sea','see','shadow','she','shine','ship','shot','show','sing','sit','skin','sky','sleep','smear','smell','smooth','so','soar','some','sordid','spray','spring','still','stop','storm','suit','summer','sun','sweat','sweet','swim','symphony','the','their','there','these','they','those','though','thousand','through','time','tiny','to','together','tongue','trudge','TV','ugly','up','urge','us','use','want','was','watch','water','wax','we','were','what','when','whisper','who','why','will','wind','with','woman','worship','y','yet','yo']
AS arr
)
INSERT INTO magnets (x, y, rotation, word, last_modifier)
SELECT
    (random() * 400001)::int - 200000 AS x,
    (random() * 400001)::int - 200000 AS y,
    (random() * 11)::int - 5 AS rotation,
    arr[1 + (random() * (array_length(arr, 1) - 1))::int] AS word,
    NULL
FROM words_array
CROSS JOIN generate_series(1, 2000000);