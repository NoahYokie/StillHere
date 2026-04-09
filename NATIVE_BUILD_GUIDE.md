# How to Turn StillHere Into a Phone App

This guide will help you turn your StillHere website into a real phone app that you can install from the Google Play Store or Apple App Store. Follow each step in order. Don't skip any steps.

You have a Windows laptop, so this guide is written for Windows. You do NOT need a Mac.

---

## PART 1: Get Your Computer Ready

You need to install 2 things on your Windows laptop before we start.

### Step 1: Install Node.js

Node.js is a program that lets you run the app on your computer.

1. Open your web browser
2. Go to **https://nodejs.org**
3. Click the big green button that says **"Download Node.js (LTS)"** (make sure it says version 22 or higher)
4. Open the downloaded file and click **Next, Next, Next, Install** (just accept all the default options)
5. When it finishes, click **Finish**

**Check it worked:** Open the program called "Command Prompt" (search for "cmd" in your Start menu), type this, and press Enter:
```
node --version
```
You should see a number like `v22.x.x`. If you see that, you're good.

### Step 2: Install Android Studio

Android Studio is a program that builds Android phone apps.

1. Go to **https://developer.android.com/studio**
2. Click **Download Android Studio**
3. Accept the terms and click **Download**
4. Open the downloaded file and click **Next, Next, Next, Install**
5. When it finishes, click **Next** and then **Finish**
6. Android Studio will open and ask to download some extra files. Let it do that. This can take 10 to 20 minutes. Just wait until it says it's done.

**Important:** Leave Android Studio open for now.

---

## PART 2: Download Your App Code

### Step 3: Download the code from Replit

1. Go to your StillHere project in Replit
2. Click the three dots menu (top left, near the project name)
3. Click **"Download as ZIP"**
4. Save the ZIP file to your Desktop
5. Right-click the ZIP file and choose **"Extract All"**
6. You should now have a folder on your Desktop called something like `stillhere` or similar

### Step 4: Open the folder in Command Prompt

1. Open **Command Prompt** (search for "cmd" in Start menu)
2. Type this command and press Enter (replace `YourName` with your actual Windows username, and use the actual folder name):
```
cd C:\Users\YourName\Desktop\stillhere
```

**Tip:** If you're not sure of the folder path, open the folder in File Explorer, click on the address bar at the top, and copy the path. Then type `cd ` (with a space after it) and paste the path.

---

## PART 3: Build the App

### Step 5: Install the project files

In Command Prompt (make sure you're still in the project folder), type:
```
npm install
```
Wait for it to finish. You'll see a lot of text scrolling. That's normal. Wait until you see a new blank line where you can type again.

### Step 6: Build the website files

Type:
```
npm run build
```
Wait for it to finish. This turns your website into files that can go inside a phone app.

### Step 7: Add Android to your project

Type:
```
npx cap add android
```
This creates an `android` folder in your project. That folder is your Android app.

### Step 8: Copy your website into the Android app

Type:
```
npx cap sync
```
This puts your website files inside the Android app and installs everything it needs.

---

## PART 4: Open Your App in Android Studio

### Step 9: Open the Android project

Type:
```
npx cap open android
```
This opens your app in Android Studio. Wait for Android Studio to finish loading (it will say "Indexing" or "Syncing" at the bottom. Wait until that finishes).

### Step 10: Set up a phone to test on

You have two options. Pick one:

**Option A: Use a virtual phone (easier, no real phone needed)**

1. In Android Studio, click **Tools** in the top menu
2. Click **Device Manager**
3. Click **Create Device**
4. Pick **Pixel 7** (or any phone in the list) and click **Next**
5. Click **Download** next to one of the system images (pick the top one), wait for it to download
6. Click **Next**, then **Finish**
7. Your virtual phone will appear in the Device Manager list

**Option B: Use your real Android phone**

1. On your phone, go to **Settings**
2. Scroll down and tap **About Phone**
3. Find **Build Number** and tap it **7 times** quickly (this turns on Developer Mode)
4. Go back to Settings, you'll now see **Developer Options**
5. Open **Developer Options** and turn on **USB Debugging**
6. Plug your phone into your computer with a USB cable
7. When your phone asks "Allow USB debugging?", tap **Allow**

### Step 11: Run the app

1. At the top of Android Studio, you'll see a green triangle (play button) ▶
2. Next to it, there's a dropdown that shows your phone (virtual or real)
3. Click the green play button ▶
4. Wait. The first time takes a few minutes.
5. Your app will open on the phone. That's it. You made an app.

---

## PART 5: Make It Look Professional

### Step 12: Change the app icon

Your app icon is the little picture people see on their phone's home screen.

1. In Android Studio, look at the left panel (it shows your project files)
2. Right-click on the folder called **res**
3. Click **New** then **Image Asset**
4. Where it says "Path", click the folder icon and find the file `client/public/icons/icon-512x512.png` in your project
5. Click **Next**, then **Finish**
6. Your app now has the StillHere icon

### Step 13: Test the app works

Open the app on the phone (virtual or real) and test these things:
- Can you see the login screen?
- Can you enter a phone number?
- Does the app look right?

If the app shows a blank white screen, don't worry. See the "Help! Something is wrong" section at the bottom.

---

## PART 6: Publish to Google Play Store

When your app works and you're happy with it, you can put it on the Google Play Store so anyone can download it.

### Step 14: Create a Google Play developer account

1. Go to **https://play.google.com/console**
2. Sign in with your Google account
3. Pay the one-time fee of **$25**
4. Fill in your developer details

### Step 15: Build the final version

1. In Android Studio, click **Build** in the top menu
2. Click **Generate Signed Bundle / APK**
3. Choose **Android App Bundle** and click **Next**
4. Click **Create new** (this creates a "keystore", which is like a password for your app)
   - Pick a location to save it (put it somewhere safe, like your Documents folder)
   - Make up a password and write it down somewhere safe. **You will need this every time you update your app. If you lose it, you cannot update your app.**
   - Fill in any name for the alias (like "stillhere")
   - Click **OK**
5. Click **Next**, choose **release**, and click **Create**
6. Wait for it to finish. It will tell you where the file was saved.

### Step 16: Upload to Play Store

1. Go back to **https://play.google.com/console**
2. Click **Create app**
3. Fill in:
   - App name: **StillHere**
   - Language: English
   - App type: App
   - Free or paid: choose based on your pricing
4. Click **Create app**
5. On the left side, click **Production** under "Release"
6. Click **Create new release**
7. Upload the `.aab` file you made in Step 15
8. Write some release notes like "First version of StillHere"
9. Click **Review release**, then **Start rollout to Production**

You'll also need to fill in the store listing (description, screenshots, etc.) before Google will approve your app. Google reviews every app, which usually takes 1 to 3 days.

---

## PART 7: iOS (iPhone) App

Since you don't have a Mac, you'll use a free cloud service to build the iPhone version.

### Step 17: Create an Apple Developer account

1. Go to **https://developer.apple.com**
2. Click **Account** and sign in with your Apple ID (create one if you don't have one)
3. Enroll in the Apple Developer Program. This costs **$99/year**
4. Wait for Apple to approve your enrollment (usually 24 to 48 hours)

### Step 18: Push your code to GitHub

Your code needs to be on GitHub so the cloud build service can access it.

1. Go to **https://github.com** and create a free account (or sign in)
2. Click the **+** button in the top right and choose **New repository**
3. Name it `stillhere` and click **Create repository**
4. In Command Prompt (in your project folder), type these commands one at a time:
```
git init
git add .
git commit -m "first version"
git remote add origin https://github.com/YourUsername/stillhere.git
git branch -M main
git push -u origin main
```
Replace `YourUsername` with your actual GitHub username.

### Step 19: Add iOS to your project

In Command Prompt, type:
```
npx cap add ios
```

Then push the update to GitHub:
```
git add .
git commit -m "add ios"
git push
```

### Step 20: Set up Codemagic (cloud build service)

1. Go to **https://codemagic.io**
2. Click **Sign up** and sign in with your GitHub account
3. Click **Add application** and choose your `stillhere` repository
4. Choose **Capacitor** as the project type
5. In the build settings:
   - Platform: **iOS**
   - Build mode: **Release**
6. Under **Code signing**, click **Add** and follow the steps to connect your Apple Developer account
   - Codemagic will create the certificates and provisioning profiles for you automatically
7. Click **Start new build**
8. Wait for the build to finish (10 to 20 minutes)
9. Download the `.ipa` file when it's done

### Step 21: Upload to App Store

1. Codemagic can upload directly to App Store Connect. In your Codemagic settings, enable **"Publish to App Store Connect"**
2. Or go to **https://appstoreconnect.apple.com** manually:
   - Click **My Apps** then the **+** button and **New App**
   - Fill in the app name, bundle ID (`com.stillhere.app`), and other details
   - Upload the `.ipa` file
   - Fill in the store listing (description, screenshots, etc.)
   - Submit for review

Apple reviews every app, which usually takes 1 to 2 days.

---

## PART 8: Updating Your App Later

Every time you make changes to StillHere in Replit:

1. Download the updated code from Replit (ZIP or git pull)
2. Open Command Prompt in the project folder
3. Run these 3 commands:
```
npm install
npm run build
npx cap sync
```
4. Open Android Studio (`npx cap open android`), build a new version, upload to Play Store
5. Push to GitHub and trigger a new Codemagic build for iOS

---

## Help! Something Is Wrong

### The app shows a blank white screen
This usually means the website files didn't get copied properly. Run this in Command Prompt:
```
npm run build
npx cap sync
```
Then run the app again in Android Studio.

### It says "JAVA_HOME is not set"
1. Search for "Environment Variables" in your Start menu
2. Click "Edit the system environment variables"
3. Click "Environment Variables" button
4. Under "System variables", click "New"
5. Variable name: `JAVA_HOME`
6. Variable value: `C:\Program Files\Android\Android Studio\jbr` (this is where Android Studio puts Java)
7. Click OK on everything
8. Close and reopen Command Prompt

### It says "SDK location not found"
1. Open the `android` folder in your project
2. Create a new text file called `local.properties` (not `local.properties.txt`, just `local.properties`)
3. Put this line in it (replace `YourName` with your Windows username):
```
sdk.dir=C:\\Users\\YourName\\AppData\\Local\\Android\\Sdk
```
4. Save the file

### Android Studio is really slow
That's normal the first time. It downloads a lot of files. After the first time, it will be faster.

### The virtual phone is really slow
1. In Android Studio, click **Tools** then **SDK Manager**
2. Click the **SDK Tools** tab
3. Make sure **"Android Emulator Hypervisor Driver"** is checked
4. Click **Apply** and let it install
5. Restart your computer

### "npm" is not recognized
Node.js isn't installed properly. Go back to Step 1 and install it again. After installing, close and reopen Command Prompt.

### My phone isn't showing up in Android Studio
1. Make sure USB Debugging is turned on (Step 10, Option B)
2. Try a different USB cable (some cables are charge-only and don't transfer data)
3. On your phone, when it asks about the USB connection, choose "File Transfer" or "MTP"

---

## Summary of Costs

| What | Cost | When |
|---|---|---|
| Google Play Store developer account | $25 | One time, forever |
| Apple Developer account | $99 | Every year |
| Codemagic (iOS builds) | Free tier available | Free for limited builds |

---

## Quick Reference: All The Commands

Here's every command you'll use, in order:

```
npm install              (install project files)
npm run build            (build the website)
npx cap add android      (create Android app, only do this once)
npx cap add ios          (create iOS app, only do this once)
npx cap sync             (copy website into the apps)
npx cap open android     (open in Android Studio)
```
