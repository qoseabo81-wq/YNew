try {
    const lib = require('@dongdev/fca-unofficial');
    console.log('✅ المكتبة تعمل ويمكن تحميلها');
    console.log(lib);
} catch (error) {
    console.log('❌ المكتبة لا تعمل');
    console.error(error.message);
}
